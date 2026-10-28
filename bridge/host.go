//go:build js && wasm

package main

import (
	"runtime"
	"sync"
	"sync/atomic"
)

// hostCallback binds one posted occurrence of a host function; it lives while Go or the guest reaches it.
type hostCallback struct {
	id int
	b  *bridge
}

// bindCallback is set by main; the parser binds every function wire it reads.
var bindCallback func(id int) *hostCallback

type releaseState struct {
	releaseMu         sync.Mutex
	releasedCallbacks []int
	releasedSymbols   []symbolKey
	liveCallbacks     atomic.Int64
}

func (b *bridge) bindCallback(id int) *hostCallback {
	cb := &hostCallback{id: id, b: b}
	b.liveCallbacks.Add(1)
	runtime.AddCleanup(cb, b.callbackCollected, id)
	return cb
}

// callbackCollected runs on the cleanup goroutine, so it only queues the id for the next post.
func (b *bridge) callbackCollected(id int) {
	b.releaseMu.Lock()
	b.releasedCallbacks = append(b.releasedCallbacks, id)
	b.releaseMu.Unlock()
	b.liveCallbacks.Add(-1)
}

// callHost pauses the owning Go invocation while trusted host code handles the
// callback. Reentrant requests use that paused invocation's realm and job hold.
func (b *bridge) callHost(callbackID int, args []wireValue, this wireValue) (wireValue, error) {
	b.nextHostCall++
	id := b.nextHostCall
	ch := make(chan *payload, 1)
	b.hostMu.Lock()
	// Nothing would answer a call made once close began.
	if b.closed.Load() {
		b.hostMu.Unlock()
		return wireValue{}, wireError("bridge closed")
	}
	if b.hostWaiters == nil {
		b.hostWaiters = make(map[int]chan *payload)
	}
	b.hostWaiters[id] = ch
	b.hostMu.Unlock()
	depth := b.nestedDepth
	b.syncHostActive.Add(1)
	defer b.syncHostActive.Add(-1)
	b.postHostCall(id, callbackID, args, this)
	b.replayDeferred()
	reply := <-ch
	b.awaitNested(depth)
	if reply.Error != nil {
		return wireValue{}, b.hostError(reply.Error)
	}
	return reply.Value, nil
}
