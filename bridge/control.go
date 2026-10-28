//go:build js && wasm

package main

import (
	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/eventloop"
)

type loopOptions struct {
	Disabled           bool      `json:"disabled"`
	OnError            wireValue `json:"onError"`
	ResetMemoryPerTask bool      `json:"resetMemoryPerTask"`
}

type controlPayload struct {
	LoopOptions      *loopOptions  `json:"loopOptions"`
	RejectionTracker wireValue     `json:"rejectionTracker"`
	PromiseID        int           `json:"promiseId"`
	HoldID           int           `json:"holdId"`
	Task             wireValue     `json:"task"`
	InterruptError   *errorPayload `json:"interruptError"`
	// The host's seq for this interrupt, sent first so a malformed reason still wakes a parked poll.
	InterruptSeq int `json:"interruptSeq"`
}

// runtimePromise holds Runtime.NewPromise's settlers: no loop hold, and no live root.
type runtimePromise struct{ resolve, reject func(moejs.Value) error }

type controlledPromise struct {
	value      moejs.Value
	settle     func(func(*moejs.Runtime) (moejs.Value, error))
	settlement moejs.Value
	scheduled  bool
}

type controlState struct {
	promises           map[int]controlledPromise
	holds              map[int]func(func(*moejs.Runtime))
	nextPromise        int
	nextHold           int
	removeControlRoots func()
	tasks              map[int]moejs.Value
	nextTask           int
	runtimePromises    map[int]runtimePromise
	nextRuntimePromise int
}

func (b *bridge) initializeControl(p *payload) {
	b.promises = make(map[int]controlledPromise)
	b.holds = make(map[int]func(func(*moejs.Runtime)))
	b.tasks = make(map[int]moejs.Value)
	b.runtimePromises = make(map[int]runtimePromise)
	b.removeControlRoots = b.rt.AddLiveRoots(func(add func(moejs.Value)) {
		for _, p := range b.promises {
			add(p.value)
			add(p.settlement)
		}
		for _, task := range b.tasks {
			add(task)
		}
	})
	b.trackPromiseRejections(p.RejectionTracker)
}

func (b *bridge) releaseControl() {
	if b.removeControlRoots != nil {
		b.removeControlRoots()
		b.removeControlRoots = nil
	}
	clear(b.promises)
	clear(b.holds)
	clear(b.tasks)
	clear(b.runtimePromises)
}

func promiseStateName(state moejs.PromiseState) string {
	switch state {
	case moejs.PromiseFulfilled:
		return "fulfilled"
	case moejs.PromiseRejected:
		return "rejected"
	default:
		return "pending"
	}
}

// promiseState is upstream PromiseResult: a pure read, ok false for a non-promise.
func (b *bridge) promiseState(p *payload) (any, error) {
	value, err := b.decode(p.Value, false, 0)
	if err != nil {
		return nil, err
	}
	state, result, ok := moejs.PromiseResult(value)
	return map[string]any{"state": promiseStateName(state), "result": b.retainValue(result), "ok": ok}, nil
}

// trackPromiseRejections calls the host synchronously, in the operation that rejected or handled.
func (b *bridge) trackPromiseRejections(callback wireValue) {
	cb, ok := callback.V.(*hostCallback)
	if !ok {
		b.rt.SetPromiseRejectionTracker(nil)
		return
	}
	b.rt.SetPromiseRejectionTracker(func(p moejs.Value, op moejs.PromiseRejectionOperation) {
		operation := "reject"
		if op == moejs.PromiseRejectionHandle {
			operation = "handle"
		}
		state, result, _ := moejs.PromiseResult(p)
		args := []wireValue{b.retainValue(p), {T: "string", V: operation}, {T: "string", V: promiseStateName(state)}, b.retainValue(result)}
		_, _ = b.callHost(cb.id, args, wireValue{T: "undefined"})
	})
}

// Lifecycle controls must not wait behind a Promise-returning guest call. They
// also bypass guard: ClearInterrupt must work while CheckInterrupt would fail.
func (b *bridge) acceptControl(req *request) bool {
	switch req.Op {
	case "interrupt", "clearInterrupt", "loopNew", "loopStart", "loopRun", "loopStop", "loopStopNoWait", "loopTerminate", "loopHold", "loopRelease", "loopPost", "loopRunOnLoop", "promiseResolve", "promiseReject", "promiseSettle", "networkClose", "networkSetContext", "networkCancelContext", "networkCancelParent":
	default:
		return false
	}
	if req.payloadErr != nil {
		b.respond(req.ID, nil, req.payloadErr)
		return true
	}
	p := &req.p
	if b.rt == nil {
		b.respond(req.ID, nil, wireError("runtime is not initialized"))
		return true
	}
	switch req.Op {
	case "interrupt", "clearInterrupt", "loopNew", "networkClose", "networkSetContext", "networkCancelContext", "networkCancelParent":
	default:
		if b.loop == nil {
			b.respond(req.ID, nil, wireError("runtime has no event loop"))
			return true
		}
	}
	var result any
	var err error
	switch req.Op {
	case "networkClose", "networkSetContext", "networkCancelContext", "networkCancelParent":
		out, _, e := b.dispatchNetwork(req.Op, p)
		b.respond(req.ID, out.data, e)
		return true
	case "interrupt":
		var pinned *errorPayload
		if p.InterruptError != nil {
			copied := b.pinPayload(*p.InterruptError)
			pinned = &copied
		}
		reason := interruptValue(pinned)
		if b.loop != nil {
			b.loop.Interrupt(reason)
		} else {
			b.rt.Interrupt(reason)
		}
		interrupted := &moejs.InterruptedError{Value: reason}
		b.interruptModules(interrupted)
		closing := errorPayload{Kind: "interrupted", Name: "InterruptedError", Code: "ERR_INTERRUPTED", Message: "interrupted"}
		if pinned != nil {
			closing = *pinned
		}
		b.closeHostCalls(closing)
		// A running loop returns and rejects them itself; a stopped one never would.
		if b.loopStopped.Load() {
			b.rejectPending(interrupted)
		}
	case "clearInterrupt":
		// As upstream, clearing stops nothing; a loop the interrupt is ending returns first.
		if b.rt.Realm().Interrupted() && b.syncHostActive.Load() == 0 && b.loopDone != nil {
			<-b.loopDone
		}
		b.rt.ClearInterrupt()
		b.releaseHostCallHolds()
	case "loopNew":
		if b.loop != nil && b.loop.RunOnLoop(nil) {
			err = wireError("runtime already has an event loop")
			break
		}
		if b.loopDone != nil {
			<-b.loopDone
		}
		b.releaseHostCallHolds()
		// Like eventloop.New, the new loop is not started.
		err = b.initializeLoop(p.LoopOptions)
	case "loopStart":
		if !b.loopStopped.Load() {
			// The first start takes over the loop newRuntime started.
			if !b.implicitStart.CompareAndSwap(true, false) {
				err = eventloop.ErrRunning
			}
			break
		}
		if b.loopDone != nil {
			<-b.loopDone
		}
		if !b.loop.RunOnLoop(nil) {
			err = eventloop.ErrTerminated
			break
		}
		b.beginLoop(true, 0, nil, nil)
	case "loopRun":
		if !b.loopStopped.Load() && !b.implicitStart.Load() {
			b.respond(req.ID, nil, eventloop.ErrRunning)
			return true
		}
		b.implicitStart.Store(false)
		b.waitLoop()
		if b.releaseLoop != nil {
			b.releaseLoop(nil)
			b.releaseLoop = nil
		}
		if !b.loop.RunOnLoop(nil) {
			b.respond(req.ID, nil, eventloop.ErrTerminated)
			return true
		}
		var fn func(*moejs.Runtime) error
		var fnFailed bool
		if p.Task.T != "" {
			value, e := b.decode(p.Task, true, 0)
			if e != nil {
				b.respond(req.ID, nil, e)
				return true
			}
			b.nextTask++
			taskID := b.nextTask
			b.tasks[taskID] = value
			fn = func(rt *moejs.Runtime) error {
				defer delete(b.tasks, taskID)
				e := b.guard(func() error { _, e := rt.CallFunction(value, moejs.Undefined()); return e })
				if e != nil && rt.Realm().Interrupted() {
					// closeHostCalls turned the interrupt into the host call's error.
					e = rt.Realm().CheckInterrupt()
				}
				fnFailed = e != nil
				return e
			}
		}
		b.beginLoop(false, req.ID, fn, &fnFailed)
		return true
	case "loopStop":
		err = b.loop.Stop()
		if b.loopDone != nil {
			<-b.loopDone
		}
	case "loopStopNoWait":
		b.loop.StopNoWait()
	case "loopTerminate":
		b.loop.Terminate()
		if b.loopDone != nil {
			<-b.loopDone
		}
		if b.releaseLoop != nil {
			b.releaseLoop(nil)
			b.releaseLoop = nil
		}
		clear(b.holds)
		clear(b.promises)
		clear(b.tasks)
		b.releaseHostCallHolds()
		b.rejectPending(eventloop.ErrTerminated)
	case "loopHold":
		b.nextHold++
		// After Terminate, Hold's done function does nothing, as upstream.
		if b.loop.RunOnLoop(nil) {
			b.holds[b.nextHold] = b.loop.Hold()
		}
		result = b.nextHold
	case "loopRelease":
		done, ok := b.holds[p.HoldID]
		if !ok {
			break
		}
		if p.Task.T == "" {
			delete(b.holds, p.HoldID)
			done(nil)
			break
		}
		release := func(_ *moejs.Runtime) {
			if !b.loop.RunOnLoop(nil) {
				delete(b.holds, p.HoldID)
				done(nil)
				b.respond(req.ID, nil, nil)
				return
			}
			fn, e := b.decode(p.Task, true, 0)
			if e != nil {
				b.respond(req.ID, nil, e)
				return
			}
			b.nextTask++
			taskID := b.nextTask
			b.tasks[taskID] = fn
			delete(b.holds, p.HoldID)
			// Hold's done fn has no error result upstream, so its error is dropped.
			done(func(rt *moejs.Runtime) {
				defer delete(b.tasks, taskID)
				_ = b.guard(func() error { _, e := rt.CallFunction(fn, moejs.Undefined()); return e })
			})
			b.respond(req.ID, nil, nil)
		}
		if p.Reentrant && b.syncHostActive.Load() > 0 {
			release(b.rt)
			return true
		}
		if b.loopStopped.Load() {
			if b.loopDone != nil {
				<-b.loopDone
			}
			release(b.rt)
		} else if !b.loop.RunOnLoop(release) {
			b.respond(req.ID, nil, eventloop.ErrTerminated)
		}
		return true
	case "loopPost", "loopRunOnLoop":
		// RunOnLoop(nil) and Post(l, nil) report whether the loop is alive.
		if p.Task.T == "" {
			b.respond(req.ID, b.loop.RunOnLoop(nil), nil)
			return true
		}
		enqueue := func(_ *moejs.Runtime) {
			fn, e := b.decode(p.Task, true, 0)
			if e != nil {
				b.respond(req.ID, nil, e)
				return
			}
			b.nextTask++
			taskID := b.nextTask
			b.tasks[taskID] = fn
			task := func(rt *moejs.Runtime) error {
				defer delete(b.tasks, taskID)
				return b.guard(func() error { _, e := rt.CallFunction(fn, moejs.Undefined()); return e })
			}
			var accepted bool
			if req.Op == "loopPost" {
				accepted = eventloop.Post(b.loop, task)
			} else {
				accepted = b.loop.RunOnLoop(func(rt *moejs.Runtime) { _ = task(rt) })
			}
			if !accepted {
				delete(b.tasks, taskID)
			}
			b.respond(req.ID, accepted, nil)
		}
		if p.Reentrant && b.syncHostActive.Load() > 0 {
			enqueue(b.rt)
			return true
		}
		if b.loopStopped.Load() {
			if b.loopDone != nil {
				<-b.loopDone
			}
			enqueue(b.rt)
		} else if !b.loop.RunOnLoop(enqueue) {
			b.respond(req.ID, false, nil)
		}
		return true
	case "promiseResolve", "promiseReject", "promiseSettle":
		// Decode and access the resolver on its owning loop, even when the control
		// arrived while another operation was awaiting this very promise.
		action := func(_ *moejs.Runtime) {
			out, _, e := b.dispatchControl(req.Op, p)
			b.respond(req.ID, out.data, e)
		}
		if p.Reentrant && b.syncHostActive.Load() > 0 {
			action(b.rt)
			return true
		}
		if b.loopStopped.Load() {
			if b.loopDone != nil {
				<-b.loopDone
			}
			action(b.rt)
		} else if !b.loop.RunOnLoop(action) {
			// NewPromise's settle function does nothing after Terminate.
			b.respond(req.ID, nil, nil)
		}
		return true
	}
	b.respond(req.ID, result, err)
	return true
}

func (b *bridge) dispatchControl(op string, p *payload) (operationResult, bool, error) {
	out := operationResult{}
	switch op {
	case "newPromise":
		if b.loop == nil {
			return out, true, wireError("runtime has no event loop")
		}
		promise, settle := b.loop.NewPromise()
		b.nextPromise++
		// After Terminate the promise never settles, so it is not kept for a settle.
		if b.loop.RunOnLoop(nil) {
			b.promises[b.nextPromise] = controlledPromise{value: promise, settle: settle}
		}
		out.data = map[string]any{"promiseId": b.nextPromise, "promise": b.retainValue(promise)}
	case "promiseResolve", "promiseReject", "promiseSettle":
		promise, ok := b.promises[p.PromiseID]
		if !ok {
			if p.PromiseID > 0 && p.PromiseID <= b.nextPromise {
				return out, true, nil
			}
			return out, true, wireError("unknown host Promise")
		}
		if promise.scheduled {
			return out, true, nil
		}
		wire := p.Value
		if op == "promiseSettle" {
			wire = p.Task
		}
		value := moejs.Undefined()
		if wire.T != "" {
			var err error
			if value, err = b.decode(wire, true, 0); err != nil {
				return out, true, err
			}
		}
		promise.settlement, promise.scheduled = value, true
		b.promises[p.PromiseID] = promise
		id := p.PromiseID
		promise.settle(func(rt *moejs.Runtime) (moejs.Value, error) {
			delete(b.promises, id)
			switch op {
			case "promiseReject":
				return moejs.Undefined(), &moejs.Exception{Value: value}
			case "promiseSettle":
				if wire.T == "" {
					return moejs.Undefined(), nil
				}
				var result moejs.Value
				err := b.guard(func() error { var e error; result, e = rt.CallFunction(value, moejs.Undefined()); return e })
				if err != nil && rt.Realm().Interrupted() {
					return moejs.Undefined(), rt.Realm().CheckInterrupt()
				}
				return result, err
			}
			return value, nil
		})
	case "runtimePromiseResolve", "runtimePromiseReject":
		settler, ok := b.runtimePromises[p.PromiseID]
		if !ok {
			return out, true, nil
		}
		value, err := b.decode(p.Value, true, 0)
		if err != nil {
			return out, true, err
		}
		delete(b.runtimePromises, p.PromiseID)
		if op == "runtimePromiseReject" {
			return out, true, settler.reject(value)
		}
		return out, true, settler.resolve(value)
	case "setPromiseRejectionTracker":
		b.trackPromiseRejections(p.RejectionTracker)
	case "rebaseAllocation":
		return out, true, b.rt.RebaseAllocation(nil)
	default:
		return out, false, nil
	}
	return out, true, nil
}
