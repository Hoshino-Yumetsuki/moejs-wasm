//go:build js && wasm

package main

import (
	"runtime/debug"
	"sync"
	"sync/atomic"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/eventloop"
	"github.com/Calcium-Ion/moejs/webapi"
)

// The control lock serializes access while the native loop is paused.
// Only a native loop task, or the host between runs, touches guest values.
type loopState struct {
	control     sync.Mutex
	closed      atomic.Bool
	loopStopped atomic.Bool
	// implicitStart is the run newRuntime started, which the first start or run takes over.
	implicitStart atomic.Bool
	loop          *eventloop.Loop
	webAPI        *webapi.API
	releaseLoop   func(func(*moejs.Runtime))
	loopDone      chan struct{}
}

func (b *bridge) accept(raw string) {
	req, err := parseRequest(raw)
	if err != nil {
		b.respond(0, nil, wireError(err.Error()))
		return
	}
	switch req.Op {
	case "moduleResult":
		b.acceptModuleResult(req.Payload)
		return
	case "interruptWord":
		// Only a worker reads the word; an adapter that forwards it here gets no effect.
		return
	case "close":
		b.closeRuntime(req.ID)
		return
	}
	if !req.decoded {
		req.payloadErr = req.p.UnmarshalJSON(req.Payload)
	}
	if req.Op == "settle" && req.payloadErr == nil && b.acceptHostSettlement(&req.p) {
		return
	}
	if b.acceptNested(req) {
		return
	}
	if req.Op == "interrupt" {
		b.acceptControl(req)
		b.noteInterrupt(req.p.InterruptSeq)
		return
	}
	b.control.Lock()
	defer b.control.Unlock()
	if b.closed.Load() {
		b.respond(req.ID, nil, wireError("bridge closed"))
		return
	}
	if b.acceptControl(req) {
		return
	}
	// An async host function's result settles in a loop task, as upstream NewPromise's does.
	if req.Op == "settle" && req.payloadErr == nil && b.loop != nil && !b.loopStopped.Load() {
		eventloop.Post(b.loop, func(*moejs.Runtime) error {
			err := b.guard(func() error { return b.settleHostCall(&req.p) })
			b.poll()
			return err
		})
		return
	}
	if b.loop == nil || b.loopStopped.Load() {
		if b.loopDone != nil {
			<-b.loopDone
		}
		b.dispatch(req)
		return
	}
	if !b.loop.RunOnLoop(func(_ *moejs.Runtime) { b.dispatch(req) }) {
		b.respond(req.ID, nil, eventloop.ErrTerminated)
	}
}

func (b *bridge) initializeLoop(o *loopOptions) error {
	opts := eventloop.Options{}
	if o != nil {
		opts.ResetMemoryPerTask = o.ResetMemoryPerTask
		if cb, ok := o.OnError.V.(*hostCallback); ok {
			opts.OnError = b.loopErrorHandler(cb)
		}
	}
	loop, err := eventloop.New(b.rt, opts)
	if err != nil {
		return err
	}
	b.loop, b.loopDone, b.releaseLoop = loop, nil, nil
	b.loopStopped.Store(true)
	b.implicitStart.Store(false)
	return nil
}

// loopErrorHandler is Options.OnError, synchronous on the loop; its values live while the host keeps them.
func (b *bridge) loopErrorHandler(cb *hostCallback) func(error) {
	return func(err error) {
		text := appendJSON(nil, b.errorPayload(err))
		_, _ = b.callHost(cb.id, []wireValue{{T: "string", V: string(text)}}, wireValue{T: "undefined"})
	}
}

// A background hold gives Start its native wait-while-idle semantics, but is
// released for explicit Run, whose result is delivered only when it goes idle.
func (b *bridge) startLoop() { b.beginLoop(true, 0, nil, nil) }

func (b *bridge) beginLoop(background bool, id int, fn func(*moejs.Runtime) error, fnFailed *bool) {
	if background && b.releaseLoop == nil {
		b.releaseLoop = b.loop.Hold()
	}
	b.loopStopped.Store(false)
	done := make(chan struct{})
	b.loopDone = done
	go func() {
		var err error
		defer func() {
			if value := recover(); value != nil {
				err = &moejs.InternalError{Value: value, Stack: debug.Stack()}
			}
			b.loopStopped.Store(true)
			if background {
				b.implicitStart.Store(false)
			}
			if !b.closed.Load() {
				// A fn error is Run's result, not a loop failure.
				if err != nil && (fnFailed == nil || !*fnFailed) {
					b.loopFailed(err)
				}
				if id != 0 {
					b.respond(id, nil, err)
				}
			}
			close(done)
		}()
		err = b.loop.Run(fn)
	}()
}

func (b *bridge) loopFailed(err error) {
	// Interrupts, memory limits, and uncaught callback exceptions pause the loop;
	// neither the endpoint nor WebAPI is destroyed. ClearInterrupt permits reuse.
	b.rejectPending(err)
}

func (b *bridge) waitLoop() {
	if b.loop == nil {
		return
	}
	b.loop.Stop()
	if b.loopDone != nil {
		<-b.loopDone
	}
}

func (b *bridge) closeRuntime(id int) {
	if b.closed.Swap(true) {
		return
	}
	b.wakeInterruptPolls()
	b.closeModules()
	b.closeHostCalls(errorPayload{Kind: "closed", Name: "Error", Message: "MoeJS runtime is closed"})
	b.control.Lock()
	defer b.control.Unlock()
	b.closeWebAPI()
	if b.releaseLoop != nil {
		b.releaseLoop(nil)
		b.releaseLoop = nil
	}
	if b.loop != nil {
		b.loop.Terminate()
		if b.loopDone != nil {
			<-b.loopDone
		}
	}
	b.releaseControl()
	b.releaseValues()
	b.releaseNatives()
	clear(b.hostCalls)
	clear(b.modules)
	clear(b.linkedModules)
	clear(b.importedModules)
	clear(b.scripts)
	b.rt = nil
	b.respond(id, nil, nil)
	close(b.shutdown)
}

func (b *bridge) observePending(pending *pendingOperation, value moejs.Value) {
	if pending.observed == value.AsObject() {
		return
	}
	observer, ok := any(b.rt.Realm()).(interface {
		ObservePromise(moejs.Value, func()) bool
	})
	if !ok {
		panic("promise observation support missing: build with scripts/build-wasm.mjs")
	}
	pending.observed = value.AsObject()
	observer.ObservePromise(value, b.poll)
}
