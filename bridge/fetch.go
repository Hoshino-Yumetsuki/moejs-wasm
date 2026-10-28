//go:build js && wasm

package main

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"syscall/js"
)

const defaultUserAgent = "Go-http-client/1.1"

var uint8Array = js.Global().Get("Uint8Array")

// hostTransport sends each round trip through the host's fetch, as Go's Transport would on the wire.
type hostTransport struct{}

func (hostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx := req.Context()
	headers, defaults, addedGzip := requestHeaders(req)
	init := map[string]any{"method": req.Method, "headers": headers}
	if len(defaults) != 0 {
		init["defaults"] = defaults
	}
	body := js.Undefined()
	var stream io.ReadCloser
	switch n := outgoingLength(req); {
	case n == 0:
		if req.Body != nil {
			req.Body.Close()
		}
	case n > 0:
		data, err := io.ReadAll(req.Body)
		req.Body.Close()
		if err != nil {
			return nil, err
		}
		body = uint8Array.New(len(data))
		js.CopyBytesToJS(body, data)
	default:
		init["stream"] = true
		stream = req.Body
	}
	meta := map[string]any{"request": map[string]any{"url": fetchURL(req.URL), "method": req.Method, "headers": headers}, "init": init}
	call := host.network.Invoke("fetch", marshal(meta), body)
	id := call.Get("id").Int()
	wait, fail := context.WithCancelCause(ctx)
	defer fail(nil)
	// The body may outlast the response headers, as on Go's Transport.
	if stream != nil {
		go writeBody(ctx, id, stream, fail)
	}
	v, err := awaitNetwork(wait, call, req.URL.Hostname())
	if err != nil {
		if ctx.Err() == nil {
			// The request body failed first.
			if cause := context.Cause(wait); cause != nil && cause != context.Canceled {
				err = cause
			}
		}
		return nil, err
	}
	return hostResponse(req, v, addedGzip)
}

// awaitNetwork waits for a host network call, cancelling it when ctx ends.
func awaitNetwork(ctx context.Context, call js.Value, hostname string) (js.Value, error) {
	type result struct {
		v   js.Value
		err error
	}
	done := make(chan result, 1)
	resolve := js.FuncOf(func(_ js.Value, args []js.Value) any {
		v := js.Undefined()
		if len(args) != 0 {
			v = args[0]
		}
		done <- result{v: v}
		return nil
	})
	reject := js.FuncOf(func(_ js.Value, args []js.Value) any {
		reason := js.Undefined()
		if len(args) != 0 {
			reason = args[0]
		}
		done <- result{err: hostNetworkError(reason, hostname)}
		return nil
	})
	call.Call("then", resolve, reject)
	select {
	case r := <-done:
		resolve.Release()
		reject.Release()
		return r.v, r.err
	case <-ctx.Done():
		call.Call("cancel")
		// The host can still answer; keep the callbacks until it does.
		go func() { <-done; resolve.Release(); reject.Release() }()
		return js.Undefined(), context.Cause(ctx)
	}
}

func networkCall(ctx context.Context, kind string, meta map[string]any, bytes js.Value) (js.Value, error) {
	return awaitNetwork(ctx, host.network.Invoke(kind, marshal(meta), bytes), "")
}

func networkNotify(kind string, meta map[string]any) {
	host.network.Invoke(kind, marshal(meta), js.Undefined())
}

// networkHostError keeps the host's message and the Go error webapi's errCode looks for.
type networkHostError struct {
	msg string
	err error
}

func (e *networkHostError) Error() string { return e.msg }
func (e *networkHostError) Unwrap() error { return e.err }

func hostNetworkError(v js.Value, hostname string) error {
	if v.Type() != js.TypeObject {
		return errors.New(v.String())
	}
	msg := "Network request failed"
	if m := v.Get("message"); m.Type() == js.TypeString {
		msg = m.String()
	}
	code := ""
	if c := v.Get("code"); c.Type() == js.TypeString {
		code = c.String()
	}
	var base error
	switch code {
	case "ECONNREFUSED":
		base = syscall.ECONNREFUSED
	case "ECONNRESET":
		base = syscall.ECONNRESET
	case "UND_ERR_SOCKET":
		base = io.ErrUnexpectedEOF
	case "ENOTFOUND", "EAI_AGAIN":
		base = &net.DNSError{Err: "no such host", Name: hostname, IsNotFound: code == "ENOTFOUND", IsTemporary: code == "EAI_AGAIN"}
	case "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT":
		base = os.ErrDeadlineExceeded
	default:
		return errors.New(msg)
	}
	return &networkHostError{msg, base}
}

// requestHeaders is req.Header as sent, plus the wire defaults Go's Transport adds.
func requestHeaders(req *http.Request) (headers, defaults [][2]string, addedGzip bool) {
	for _, name := range slices.Sorted(func(yield func(string) bool) {
		for name := range req.Header {
			if !yield(name) {
				return
			}
		}
	}) {
		for _, value := range req.Header[name] {
			headers = append(headers, [2]string{name, value})
		}
	}
	if req.Host != "" && req.Host != req.URL.Host {
		headers = append(headers, [2]string{"Host", req.Host})
	}
	if _, ok := req.Header["User-Agent"]; !ok {
		defaults = append(defaults, [2]string{"User-Agent", defaultUserAgent})
	}
	if req.Header.Get("Accept-Encoding") == "" && req.Header.Get("Range") == "" && req.Method != http.MethodHead {
		defaults = append(defaults, [2]string{"Accept-Encoding", "gzip"})
		addedGzip = true
	}
	return headers, defaults, addedGzip
}

// fetchURL drops userinfo, which the client already sent as Authorization and fetch refuses.
func fetchURL(u *url.URL) string {
	if strings.HasPrefix(u.Opaque, "//") {
		return u.RequestURI()
	}
	return u.Scheme + "://" + u.Host + u.RequestURI()
}

func outgoingLength(r *http.Request) int64 {
	if r.Body == nil || r.Body == http.NoBody {
		return 0
	}
	if r.ContentLength != 0 {
		return r.ContentLength
	}
	return -1
}

func hostResponse(req *http.Request, v js.Value, addedGzip bool) (*http.Response, error) {
	code := v.Get("status").Int()
	header := make(http.Header)
	pairs := v.Get("headers")
	for i, n := 0, pairs.Length(); i < n; i++ {
		pair := pairs.Index(i)
		header.Add(pair.Index(0).String(), pair.Index(1).String())
	}
	// Go's response reader moves Transfer-Encoding out of the header.
	header.Del("Transfer-Encoding")
	bodyID := -1
	if id := v.Get("bodyId"); id.Type() == js.TypeNumber {
		bodyID = id.Int()
	}
	length := int64(-1)
	if text := header.Get("Content-Length"); text != "" {
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil || n < 0 {
			if bodyID >= 0 {
				networkNotify("cancel", map[string]any{"bodyId": bodyID})
			}
			return nil, errors.New("net/http: invalid Content-Length " + strconv.Quote(text))
		}
		length = n
	}
	text := v.Get("statusText").String()
	if text == "" {
		text = http.StatusText(code)
	}
	resp := &http.Response{Status: strconv.Itoa(code) + " " + text, StatusCode: code, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1, Header: header, ContentLength: length, Request: req, Body: http.NoBody}
	if bodyID >= 0 {
		resp.Body = newHostBody(req.Context(), bodyID)
	}
	enc := header.Get("Content-Encoding")
	decoded := v.Get("decoded").Truthy()
	// Go's Transport hides only the gzip it asked for; other decoded codings stay visible.
	gzipped := addedGzip && strings.EqualFold(enc, "gzip")
	switch {
	case enc == "":
	case decoded && gzipped:
		stripEncoding(resp)
	case decoded:
		resp.Uncompressed = true
	case gzipped:
		resp.Body = &gzipBody{src: resp.Body}
		stripEncoding(resp)
	}
	return resp, nil
}

// stripEncoding hides a coding the transport negotiated, as Go's Transport does for its gzip.
func stripEncoding(resp *http.Response) {
	resp.Header.Del("Content-Encoding")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
	resp.Uncompressed = true
}

// hostBody reads a response body chunk by chunk, never ahead of the reader.
type hostBody struct {
	id      int
	ctx     context.Context
	stop    context.CancelFunc
	pending []byte
	err     error
	eof     atomic.Bool
	once    sync.Once
}

func newHostBody(parent context.Context, id int) *hostBody {
	ctx, stop := context.WithCancel(parent)
	return &hostBody{id: id, ctx: ctx, stop: stop}
}

func (b *hostBody) Read(p []byte) (int, error) {
	for len(b.pending) == 0 {
		if b.err != nil {
			return 0, b.err
		}
		v, err := networkCall(b.ctx, "read", map[string]any{"bodyId": b.id}, js.Undefined())
		switch {
		case err != nil:
			b.err = err
		case v.Get("done").Truthy():
			b.err = io.EOF
			b.eof.Store(true)
		default:
			if chunk := v.Get("value"); chunk.Type() == js.TypeObject {
				b.pending = make([]byte, chunk.Length())
				js.CopyBytesToGo(b.pending, chunk)
			}
		}
	}
	n := copy(p, b.pending)
	b.pending = b.pending[n:]
	return n, nil
}

func (b *hostBody) Close() error {
	b.once.Do(func() {
		b.stop()
		if !b.eof.Load() {
			networkNotify("cancel", map[string]any{"bodyId": b.id})
		}
	})
	return nil
}

type gzipBody struct {
	src io.ReadCloser
	zr  *gzip.Reader
	err error
}

func (g *gzipBody) Read(p []byte) (int, error) {
	if g.err != nil {
		return 0, g.err
	}
	if g.zr == nil {
		if g.zr, g.err = gzip.NewReader(g.src); g.err != nil {
			return 0, g.err
		}
	}
	n, err := g.zr.Read(p)
	if err != nil {
		g.err = err
	}
	return n, err
}

func (g *gzipBody) Close() error { return g.src.Close() }

// writeBody streams a request body to the host one chunk at a time, as the platform takes them.
func writeBody(ctx context.Context, id int, body io.ReadCloser, fail context.CancelCauseFunc) {
	defer body.Close()
	buf := make([]byte, 32<<10)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			chunk := uint8Array.New(n)
			js.CopyBytesToJS(chunk, buf[:n])
			if _, err := networkCall(ctx, "write", map[string]any{"bodyId": id}, chunk); err != nil {
				fail(err)
				return
			}
		}
		switch {
		case err == io.EOF:
			_, _ = networkCall(ctx, "write", map[string]any{"bodyId": id}, js.Undefined())
			return
		case err != nil:
			_, _ = networkCall(ctx, "write", map[string]any{"bodyId": id, "error": err.Error()}, js.Undefined())
			fail(err)
			return
		}
	}
}

// requestSnapshot is what a host policy callback sees of a request.
func requestSnapshot(req *http.Request) map[string]any {
	headers := make([][2]string, 0, len(req.Header)+1)
	for name, values := range req.Header {
		for _, value := range values {
			headers = append(headers, [2]string{name, value})
		}
	}
	if req.Host != "" {
		headers = append(headers, [2]string{"Host", req.Host})
	}
	return map[string]any{"url": req.URL.String(), "method": req.Method, "headers": headers}
}

// hostCheckRedirect is http.Client.CheckRedirect answered by the host.
func hostCheckRedirect(req *http.Request, via []*http.Request) error {
	chain := make([]map[string]any, len(via))
	for i, r := range via {
		chain[i] = requestSnapshot(r)
	}
	v, err := networkCall(req.Context(), "checkRedirect", map[string]any{"request": requestSnapshot(req), "via": chain}, js.Undefined())
	if err != nil {
		return err
	}
	if v.Type() == js.TypeObject && v.Get("useLastResponse").Truthy() {
		return http.ErrUseLastResponse
	}
	return nil
}

// hostJar is an http.CookieJar kept by the host.
type hostJar struct{ ctx context.Context }

func (j hostJar) Cookies(u *url.URL) []*http.Cookie {
	v, err := networkCall(j.ctx, "cookies", map[string]any{"request": map[string]any{"url": u.String()}}, js.Undefined())
	if err != nil || v.Type() != js.TypeObject {
		return nil
	}
	var cookies []*http.Cookie
	for i, n := 0, v.Length(); i < n; i++ {
		if parsed, err := http.ParseCookie(v.Index(i).String()); err == nil {
			cookies = append(cookies, parsed...)
		}
	}
	return cookies
}

func (j hostJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	values := make([]string, len(cookies))
	for i, c := range cookies {
		values[i] = c.String()
	}
	_, _ = networkCall(j.ctx, "setCookies", map[string]any{"request": map[string]any{"url": u.String()}, "cookies": values}, js.Undefined())
}
