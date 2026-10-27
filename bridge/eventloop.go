//go:build js && wasm

package main

import (
	"encoding/json"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"syscall/js"

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
	loop        *eventloop.Loop
	webAPI      *webapi.API
	releaseLoop func(func(*moejs.Runtime))
	loopDone    chan struct{}
}

func (b *bridge) accept(raw string) {
	var req request
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		b.respond(0, nil, wireError(err.Error()))
		return
	}
	if req.Op == "settle" && b.acceptHostSettlement(req.Payload) {
		return
	}
	if b.acceptNested(raw, req) {
		return
	}
	if req.Op == "moduleResult" {
		b.acceptModuleResult(req.Payload)
		return
	}
	if req.Op == "close" {
		b.closeRuntime(req.ID)
		return
	}
	if req.Op == "interrupt" {
		b.acceptControl(req)
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
	if b.loop == nil || b.loopStopped.Load() {
		if b.loopDone != nil {
			<-b.loopDone
		}
		b.dispatch(raw)
		return
	}
	if !b.loop.RunOnLoop(func(_ *moejs.Runtime) { b.dispatch(raw) }) {
		b.respond(req.ID, nil, eventloop.ErrTerminated)
	}
}

func (b *bridge) initializeLoop(p payload) error {
	opts := eventloop.Options{}
	if p.LoopOptions != nil {
		opts.ResetMemoryPerTask = p.LoopOptions.ResetMemoryPerTask
		if p.LoopOptions.OnError {
			opts.OnError = func(err error) { b.emitEvent(map[string]any{"kind": "loopError", "error": b.errorPayload(err)}) }
		}
	}
	loop, err := eventloop.New(b.rt, opts)
	if err != nil {
		return err
	}
	b.loop = loop
	b.loopStopped.Store(true)
	b.initializeControl(p)
	return b.installWebAPI(p)
}

// A background hold gives Start its native wait-while-idle semantics, but is
// released for explicit Run, whose result is delivered only when it goes idle.
func (b *bridge) startLoop() { b.beginLoop(true, 0) }

func (b *bridge) beginLoop(background bool, id int) {
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
			if !b.closed.Load() {
				if err != nil {
					b.loopFailed(err)
				}
				if id != 0 {
					b.respond(id, nil, err)
				}
				event := map[string]any{"kind": "loopStopped"}
				if err != nil {
					event["error"] = b.errorPayload(err)
				}
				b.emitEvent(event)
			}
			close(done)
		}()
		err = b.loop.Run(nil)
	}()
}

func (b *bridge) emitEvent(event map[string]any) {
	event["type"] = "event"
	js.Global().Call("__moeEvent", marshal(event))
}

func (b *bridge) loopFailed(err error) {
	// Interrupts, memory limits, and uncaught callback exceptions pause the loop;
	// neither the endpoint nor WebAPI is destroyed. ClearInterrupt permits reuse.
	b.rejectPending(err)
}

func (b *bridge) waitLoop() {
	b.loop.Stop()
	if b.loopDone != nil {
		<-b.loopDone
	}
}

func (b *bridge) closeRuntime(id int) {
	if b.closed.Swap(true) {
		return
	}
	b.closeModules()
	b.closeHostCalls()
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
	b.pending = nil
	clear(b.hostCalls)
	clear(b.modules)
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
