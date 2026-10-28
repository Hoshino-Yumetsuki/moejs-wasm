//go:build js && wasm

package main

// hostInterruptSeq reads the host's interrupt word: the seq of the last interrupt it posted, 0 without a word.
//
//go:wasmimport moejs interruptSeq
func hostInterruptSeq() int32

type preemptState struct {
	interruptSeen int32
	interruptWake chan struct{}
	// Polls parked mid-dispatch; while any is, reentrant requests wait in deferred, in order.
	parkedPolls int
	deferred    []*request
	// Reentrant dispatches running above sync host waits; a wait resumes only once those above it end.
	nestedDepth   int
	nestedChanged chan struct{}
}

func (b *bridge) installInterruptPoll() {
	b.interruptWake = make(chan struct{})
	poller, ok := any(b.rt.Realm()).(interface{ SetHostInterruptPoll(func()) })
	if !ok {
		panic("interrupt poll support missing: build with scripts/build-wasm.mjs")
	}
	poller.SetHostInterruptPoll(b.pollInterrupt)
}

// pollInterrupt parks until a posted interrupt is applied; reentrant requests meanwhile are deferred.
func (b *bridge) pollInterrupt() {
	for hostInterruptSeq()-b.interruptSeen > 0 && !b.closed.Load() {
		b.parkedPolls++
		<-b.interruptWake
		b.parkedPolls--
	}
}

// deferNested queues a reentrant request that would run guest code above a dispatch parked mid-step.
func (b *bridge) deferNested(req *request) bool {
	if b.parkedPolls == 0 && len(b.deferred) == 0 {
		return false
	}
	b.deferred = append(b.deferred, req)
	return true
}

// replayDeferred runs deferred reentrant requests at a boundary where guest code may reenter.
func (b *bridge) replayDeferred() {
	for len(b.deferred) > 0 && b.parkedPolls == 0 {
		req := b.deferred[0]
		b.deferred = b.deferred[1:]
		b.dispatchNested(req)
	}
}

func (b *bridge) dispatchNested(req *request) {
	switch req.Op {
	case "clearInterrupt", "loopHold", "loopRelease", "loopPost", "loopRunOnLoop", "promiseResolve", "promiseReject", "promiseSettle", "networkClose", "networkSetContext", "networkCancelContext", "networkCancelParent":
		b.acceptControl(req)
		return
	}
	req.nested = true
	b.nestedDepth++
	b.dispatch(req)
	b.nestedDepth--
	if b.nestedChanged != nil {
		close(b.nestedChanged)
		b.nestedChanged = nil
	}
}

// awaitNested holds a resumed sync host wait until the reentrant dispatches above it ended, as upstream's nesting would.
func (b *bridge) awaitNested(depth int) {
	for b.nestedDepth > depth {
		if b.nestedChanged == nil {
			b.nestedChanged = make(chan struct{})
		}
		<-b.nestedChanged
	}
}

func (b *bridge) noteInterrupt(seq int) {
	if s := int32(seq); s-b.interruptSeen > 0 {
		b.interruptSeen = s
	}
	b.wakeInterruptPolls()
}

func (b *bridge) wakeInterruptPolls() {
	if b.interruptWake != nil {
		close(b.interruptWake)
		b.interruptWake = make(chan struct{})
	}
}
