//go:build js && wasm

package main

import "syscall/js"

// callHost pauses the owning Go invocation while trusted host code handles the
// callback. Reentrant requests use that paused invocation's realm and job hold.
func (b *bridge) callHost(callbackID int, args []wireValue, this wireValue) (wireValue, error) {
	b.nextHostCall++
	id := b.nextHostCall
	ch := make(chan payload, 1)
	b.hostMu.Lock()
	if b.hostWaiters == nil {
		b.hostWaiters = make(map[int]chan payload)
	}
	b.hostWaiters[id] = ch
	b.hostMu.Unlock()
	b.syncHostActive.Add(1)
	defer b.syncHostActive.Add(-1)
	js.Global().Call("__moeHostCall", marshal(map[string]any{"id": id, "callbackId": callbackID, "args": args, "thisValue": this}))
	reply := <-ch
	if reply.Error != nil {
		return wireValue{}, b.hostError(reply.Error)
	}
	return reply.Value, nil
}
