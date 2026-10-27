//go:build js && wasm

package main

import (
	"encoding/json"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/eventloop"
)

type loopOptions struct {
	OnError            bool `json:"onError"`
	ResetMemoryPerTask bool `json:"resetMemoryPerTask"`
}

type controlPayload struct {
	LoopOptions     *loopOptions `json:"loopOptions"`
	TrackRejections bool         `json:"trackRejections"`
	PromiseID       int          `json:"promiseId"`
	HoldID          int          `json:"holdId"`
	Task            wireValue    `json:"task"`
	InterruptReason wireValue    `json:"interruptReason"`
}

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
}

func (b *bridge) initializeControl(p payload) {
	b.promises = make(map[int]controlledPromise)
	b.holds = make(map[int]func(func(*moejs.Runtime)))
	b.tasks = make(map[int]moejs.Value)
	b.removeControlRoots = b.rt.AddLiveRoots(func(add func(moejs.Value)) {
		for _, p := range b.promises {
			add(p.value)
			add(p.settlement)
		}
		for _, task := range b.tasks {
			add(task)
		}
	})
	b.trackPromiseRejections(p.TrackRejections)
}

func (b *bridge) releaseControl() {
	if b.removeControlRoots != nil {
		b.removeControlRoots()
		b.removeControlRoots = nil
	}
	clear(b.promises)
	clear(b.holds)
	clear(b.tasks)
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

func (b *bridge) trackPromiseRejections(enabled bool) {
	if !enabled {
		b.rt.SetPromiseRejectionTracker(nil)
		return
	}
	b.rt.SetPromiseRejectionTracker(func(p moejs.Value, op moejs.PromiseRejectionOperation) {
		operation := "reject"
		if op == moejs.PromiseRejectionHandle {
			operation = "handle"
		}
		state, result, _ := moejs.PromiseResult(p)
		b.emitEvent(map[string]any{"kind": "promiseRejection", "operation": operation, "promise": b.retainValue(p), "result": b.retainValue(result), "state": promiseStateName(state)})
	})
}

// Lifecycle controls must not wait behind a Promise-returning guest call. They
// also bypass guard: ClearInterrupt must work while CheckInterrupt would fail.
func (b *bridge) acceptControl(req request) bool {
	switch req.Op {
	case "interrupt", "clearInterrupt", "loopStart", "loopRun", "loopStop", "loopStopNoWait", "loopTerminate", "loopHold", "loopRelease", "loopPost", "loopRunOnLoop", "promiseResolve", "promiseReject", "networkClose", "networkSetContext", "networkCancelContext", "networkCancelParent":
	default:
		return false
	}
	var p payload
	if err := json.Unmarshal(req.Payload, &p); err != nil {
		b.respond(req.ID, nil, err)
		return true
	}
	if b.loop == nil {
		b.respond(req.ID, nil, wireError("runtime is not initialized"))
		return true
	}
	var result any
	var err error
	switch req.Op {
	case "networkClose", "networkSetContext", "networkCancelContext", "networkCancelParent":
		out, _, e := b.dispatchNetwork(req.Op, p)
		b.respond(req.ID, out.data, e)
		return true
	case "interrupt":
		reason := wireInterruptReason{Value: p.InterruptReason}
		b.loop.Interrupt(reason)
		b.interruptModules(reason)
		b.closeHostCalls()
	case "clearInterrupt":
		b.waitLoop()
		b.rt.ClearInterrupt()
		b.fatal = nil
	case "loopStart":
		if !b.loopStopped.Load() {
			err = eventloop.ErrRunning
			break
		}
		if b.loopDone != nil {
			<-b.loopDone
		}
		if !b.loop.RunOnLoop(nil) {
			err = eventloop.ErrTerminated
			break
		}
		b.beginLoop(true, 0)
	case "loopRun":
		b.waitLoop()
		if b.releaseLoop != nil {
			b.releaseLoop(nil)
			b.releaseLoop = nil
		}
		if !b.loop.RunOnLoop(nil) {
			b.respond(req.ID, nil, eventloop.ErrTerminated)
			return true
		}
		b.beginLoop(false, req.ID)
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
		b.rejectPending(eventloop.ErrTerminated)
	case "loopHold":
		if !b.loop.RunOnLoop(nil) {
			err = eventloop.ErrTerminated
			break
		}
		b.nextHold++
		b.holds[b.nextHold] = b.loop.Hold()
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
			fn, e := b.decode(p.Task, true, 0)
			if e != nil {
				b.respond(req.ID, nil, e)
				return
			}
			b.nextTask++
			taskID := b.nextTask
			b.tasks[taskID] = fn
			delete(b.holds, p.HoldID)
			done(func(rt *moejs.Runtime) {
				defer delete(b.tasks, taskID)
				e := b.guard(func() error { _, e := rt.CallFunction(fn, moejs.Undefined()); return e })
				if e != nil {
					b.emitEvent(map[string]any{"kind": "taskError", "error": b.errorPayload(e)})
				}
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
				accepted = b.loop.RunOnLoop(func(rt *moejs.Runtime) {
					if e := task(rt); e != nil {
						b.emitEvent(map[string]any{"kind": "taskError", "error": b.errorPayload(e)})
					}
				})
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
	case "promiseResolve", "promiseReject":
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
			b.respond(req.ID, nil, eventloop.ErrTerminated)
		}
		return true
	}
	b.respond(req.ID, result, err)
	return true
}

func (b *bridge) dispatchControl(op string, p payload) (operationResult, bool, error) {
	out := operationResult{}
	switch op {
	case "newPromise":
		if !b.loop.RunOnLoop(nil) {
			return out, true, eventloop.ErrTerminated
		}
		promise, settle := b.loop.NewPromise()
		b.nextPromise++
		b.promises[b.nextPromise] = controlledPromise{value: promise, settle: settle}
		out.data = map[string]any{"promiseId": b.nextPromise, "promise": b.retainValue(promise)}
	case "promiseState":
		value, err := b.decode(p.Value, false, 0)
		if err != nil {
			return out, true, err
		}
		state, result, ok := moejs.PromiseResult(value)
		if !ok {
			return out, true, wireError("value is not a Promise")
		}
		out.data = map[string]any{"state": promiseStateName(state), "result": b.retainValue(result)}
	case "promiseResolve", "promiseReject":
		promise, ok := b.promises[p.PromiseID]
		if !ok {
			return out, true, wireError("unknown host Promise")
		}
		if promise.scheduled {
			return out, true, nil
		}
		value, err := b.decode(p.Value, true, 0)
		if err != nil {
			return out, true, err
		}
		promise.settlement = value
		promise.scheduled = true
		b.promises[p.PromiseID] = promise
		promise.settle(func(_ *moejs.Runtime) (moejs.Value, error) {
			delete(b.promises, p.PromiseID)
			if op == "promiseReject" {
				return moejs.Undefined(), &moejs.Exception{Value: value}
			}
			return value, nil
		})
	case "setPromiseRejectionTracker":
		b.trackPromiseRejections(p.TrackRejections)
	case "rebaseAllocation":
		return out, true, b.rt.RebaseAllocation(nil)
	default:
		return out, false, nil
	}
	return out, true, nil
}
