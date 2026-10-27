//go:build js && wasm

package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"syscall/js"

	"github.com/Calcium-Ion/moejs/webapi"
)

type networkOptions struct {
	AllowHosts    []string `json:"allowHosts"`
	AllowCallback bool     `json:"allowCallback"`
}

type networkPayload struct {
	NetworkContext *int `json:"networkContext"`
}

type networkState struct {
	networkMu           sync.Mutex
	networkParentCancel context.CancelFunc
	networkContexts     map[int]context.CancelFunc
}

func (b *bridge) installWebAPI(p payload) error {
	parent, cancel := context.WithCancel(context.Background())
	b.networkParentCancel = cancel
	b.networkContexts = make(map[int]context.CancelFunc)
	opts := webapi.Options{Context: parent}
	if p.Network != nil {
		allowedHost := webapi.AllowHosts(p.Network.AllowHosts...)
		if len(p.Network.AllowHosts) != 0 || p.Network.AllowCallback {
			opts.Client = &http.Client{}
		}
		opts.Allow = func(req *http.Request) error {
			if len(p.Network.AllowHosts) != 0 {
				if err := allowedHost(req); err != nil {
					return err
				}
			}
			if p.Network.AllowCallback {
				return allowHostRequest(req)
			}
			return nil
		}
	}
	api, err := webapi.Install(b.loop, opts)
	if err != nil {
		cancel()
		return err
	}
	b.webAPI = api
	return nil
}

// The hook runs on net/http's goroutine, before the native client's initial
// request and each redirect. No host callback becomes a guest global.
func allowHostRequest(req *http.Request) error {
	headers := make([][2]string, 0, len(req.Header)+1)
	for name, values := range req.Header {
		for _, value := range values {
			headers = append(headers, [2]string{name, value})
		}
	}
	if req.Host != "" {
		headers = append(headers, [2]string{"Host", req.Host})
	}
	result := make(chan error, 1)
	resolve := js.FuncOf(func(_ js.Value, _ []js.Value) any { result <- nil; return nil })
	reject := js.FuncOf(func(_ js.Value, args []js.Value) any {
		message := "Network request denied by host policy"
		if len(args) != 0 {
			message = args[0].String()
		}
		result <- errors.New(message)
		return nil
	})
	promise := js.Global().Call("__moeNetworkAllow", marshal(map[string]any{
		"url": req.URL.String(), "method": req.Method, "headers": headers,
	}))
	promise.Call("then", resolve, reject)
	select {
	case err := <-result:
		resolve.Release()
		reject.Release()
		return err
	case <-req.Context().Done():
		promise.Call("cancel")
		// The JS side can still finish its hook; retain callbacks until then.
		go func() { <-result; resolve.Release(); reject.Release() }()
		return req.Context().Err()
	}
}

func (b *bridge) dispatchNetwork(op string, p payload) (operationResult, bool, error) {
	switch op {
	case "networkClose":
		b.closeWebAPI()
	case "networkCancelParent":
		b.networkMu.Lock()
		if b.networkParentCancel != nil {
			b.networkParentCancel()
		}
		b.networkMu.Unlock()
	case "networkSetContext":
		b.networkMu.Lock()
		if p.NetworkContext == nil {
			b.webAPI.SetContext(context.TODO())
		} else {
			ctx, cancel := context.WithCancel(context.Background())
			if old := b.networkContexts[*p.NetworkContext]; old != nil {
				old()
			}
			b.networkContexts[*p.NetworkContext] = cancel
			b.webAPI.SetContext(ctx)
		}
		b.networkMu.Unlock()
	case "networkCancelContext":
		b.networkMu.Lock()
		if p.NetworkContext != nil {
			if cancel := b.networkContexts[*p.NetworkContext]; cancel != nil {
				cancel()
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
		b.networkParentCancel()
	}
	for id, cancel := range b.networkContexts {
		cancel()
		delete(b.networkContexts, id)
	}
	b.networkMu.Unlock()
}
