//go:build js && wasm

package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/Calcium-Ion/moejs/webapi"
)

type networkOptions struct {
	AllowHosts    []string `json:"allowHosts"`
	AllowHostsSet bool     `json:"allowHostsSet"`
	AllowCallback bool     `json:"allowCallback"`
	CustomFetch   bool     `json:"customFetch"`
	TimeoutMs     int64    `json:"timeoutMs"`
	CheckRedirect bool     `json:"checkRedirect"`
	Jar           bool     `json:"jar"`
}

type networkPayload struct {
	NetworkContext *int           `json:"networkContext"`
	Reason         *networkReason `json:"reason"`
}

type networkReason struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

// cause maps an AbortSignal reason to the context idiom a Go host would use.
func (r *networkReason) cause() error {
	switch {
	case r == nil || r.Name == "AbortError":
		return context.Canceled
	case r.Name == "TimeoutError":
		return context.DeadlineExceeded
	}
	return errors.New(r.Message)
}

type networkState struct {
	networkMu           sync.Mutex
	networkParentCancel context.CancelCauseFunc
	networkContexts     map[int]context.CancelCauseFunc
}

func (b *bridge) installWebAPI(p *payload) error {
	if b.webAPI != nil {
		return wireError("webapi: already installed")
	}
	parent, cancel := context.WithCancelCause(context.Background())
	opts := webapi.Options{Context: parent}
	if n := p.Network; n != nil {
		// Like a non-nil Client with a nil Allow, a custom fetch alone enables the network.
		if len(n.AllowHosts) != 0 || n.AllowCallback || n.CustomFetch {
			client := &http.Client{Transport: hostTransport{}, Timeout: time.Duration(n.TimeoutMs) * time.Millisecond}
			if n.CheckRedirect {
				client.CheckRedirect = hostCheckRedirect
			}
			if n.Jar {
				client.Jar = hostJar{parent}
			}
			opts.Client = client
		}
		allowedHost := webapi.AllowHosts(n.AllowHosts...)
		opts.Allow = func(req *http.Request) error {
			if n.AllowHostsSet {
				if err := allowedHost(req); err != nil {
					return err
				}
			}
			if n.AllowCallback {
				return allowHostRequest(req)
			}
			return nil
		}
	}
	api, err := webapi.Install(b.loop, opts)
	if err != nil {
		cancel(nil)
		return err
	}
	b.webAPI = api
	b.networkParentCancel = cancel
	b.networkContexts = make(map[int]context.CancelCauseFunc)
	return nil
}

// The hook runs on net/http's goroutine, before the native client's initial
// request and each redirect. No host callback becomes a guest global.
func allowHostRequest(req *http.Request) error {
	_, err := awaitNetwork(req.Context(), host.networkAllow.Invoke(marshal(requestSnapshot(req))), "")
	return err
}

func (b *bridge) dispatchNetwork(op string, p *payload) (operationResult, bool, error) {
	switch op {
	case "networkClose", "networkCancelParent", "networkSetContext", "networkCancelContext":
		// A runtime without Web APIs has nothing to close or cancel.
		if b.webAPI == nil {
			return operationResult{}, true, nil
		}
	}
	switch op {
	case "networkClose":
		b.closeWebAPI()
	case "networkCancelParent":
		b.networkMu.Lock()
		if b.networkParentCancel != nil {
			b.networkParentCancel(p.Reason.cause())
		}
		b.networkMu.Unlock()
	case "networkSetContext":
		b.networkMu.Lock()
		if p.NetworkContext == nil {
			b.webAPI.SetContext(nil)
		} else {
			ctx, cancel := context.WithCancelCause(context.Background())
			if old := b.networkContexts[*p.NetworkContext]; old != nil {
				old(nil)
			}
			b.networkContexts[*p.NetworkContext] = cancel
			b.webAPI.SetContext(ctx)
		}
		b.networkMu.Unlock()
	case "networkCancelContext":
		b.networkMu.Lock()
		if p.NetworkContext != nil {
			if cancel := b.networkContexts[*p.NetworkContext]; cancel != nil {
				cancel(p.Reason.cause())
				delete(b.networkContexts, *p.NetworkContext)
			}
		}
		b.networkMu.Unlock()
	default:
		return operationResult{}, false, nil
	}
	return operationResult{}, true, nil
}

func (b *bridge) closeWebAPI() {
	if b.webAPI != nil {
		b.webAPI.Close()
	}
	b.networkMu.Lock()
	if b.networkParentCancel != nil {
		b.networkParentCancel(nil)
	}
	for id, cancel := range b.networkContexts {
		cancel(nil)
		delete(b.networkContexts, id)
	}
	b.networkMu.Unlock()
}
