//go:build js && wasm

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/compiler"
	"github.com/Calcium-Ion/moejs/engine"
	"github.com/Calcium-Ion/moejs/eventloop"
	"github.com/Calcium-Ion/moejs/syntax"
)

type errorPayload struct {
	Kind      string        `json:"kind"`
	Name      string        `json:"name"`
	Message   string        `json:"message"`
	Stack     *string       `json:"stack,omitempty"`
	File      string        `json:"file,omitempty"`
	Line      int           `json:"line,omitempty"`
	Column    int           `json:"column,omitempty"`
	Value     *wireValue    `json:"value,omitempty"`
	Reason    *wireValue    `json:"reason,omitempty"`
	Cause     *errorPayload `json:"cause,omitempty"`
	Code      string        `json:"code,omitempty"`
	Path      string        `json:"path,omitempty"`
	ValueKind string        `json:"valueKind,omitempty"`
	Specifier string        `json:"specifier,omitempty"`
	Limit     *int64        `json:"limit,omitempty"`
	Allocated *int64        `json:"allocated,omitempty"`
	Live      *int64        `json:"live,omitempty"`
	Omitted   bool          `json:"omitted,omitempty"`
	Object    bool          `json:"object,omitempty"`
	Target    string        `json:"target,omitempty"`
	Field     string        `json:"field,omitempty"`
	Offset    int64         `json:"offset,omitempty"`
	HostID    int           `json:"hostId,omitempty"`
	ReasonID  int           `json:"reasonId,omitempty"`
}

func ref[T any](v T) *T { return &v }

func deref[T any](p *T) (v T) {
	if p != nil {
		v = *p
	}
	return
}

var errWireDepth = wireError("wire value nesting exceeds 10000 levels")

var sentinels = [...]struct {
	err              error
	kind, name, code string
}{
	{errExecutionBudget, "budget", "ExecutionBudgetError", "ERR_EXECUTION_BUDGET"},
	{moejs.ErrMemoryLimit, "memory", "Error", "ERR_MEMORY_LIMIT"},
	{moejs.ErrHookNotFound, "bridge", "Error", "ERR_HOOK_NOT_FOUND"},
	{moejs.ErrNotCallable, "bridge", "Error", "ERR_NOT_CALLABLE"},
	{moejs.ErrForeign, "bridge", "Error", "ERR_FOREIGN"},
	{moejs.ErrModulePending, "bridge", "Error", "ERR_MODULE_PENDING"},
	{moejs.ErrNoResolver, "bridge", "Error", "ERR_NO_RESOLVER"},
	{moejs.ErrTooDeep, "bridge", "Error", "ERR_TOO_DEEP"},
	{moejs.ErrTooLarge, "bridge", "Error", "ERR_DECODE_LIMIT"},
	{errWireDepth, "bridge", "Error", "ERR_TOO_DEEP"},
	{eventloop.ErrTerminated, "bridge", "Error", "ERR_LOOP_TERMINATED"},
	{eventloop.ErrRunning, "bridge", "Error", "ERR_LOOP_RUNNING"},
}

// Payload-rebuilt errors re-encode to their payload verbatim, so a host rethrow is lossless.

// wireInterruptReason is a host reason that is no error: a Stringer, so it has no cause.
type wireInterruptReason struct{ Payload errorPayload }

func (r wireInterruptReason) String() string {
	return strings.TrimPrefix(r.Payload.Message, "interrupted: ")
}

// wireInterruptError is a host reason that is an Error: Unwrap reaches it.
type wireInterruptError struct{ Payload errorPayload }

func (e *wireInterruptError) Error() string {
	return strings.TrimPrefix(e.Payload.Message, "interrupted: ")
}
func (e *wireInterruptError) Unwrap() error { return payloadCause(e.Payload.Cause) }

type wirePanic struct{ Payload errorPayload }

func (e *wirePanic) Error() string {
	return strings.TrimPrefix(e.Payload.Message, "moejs: internal error: ")
}
func (e *wirePanic) Unwrap() error { return payloadCause(e.Payload.Cause) }

type timeoutError struct{ ms float64 }

func (e *timeoutError) Error() string {
	return string(appendFloat([]byte("MoeJS worker request exceeded "), e.ms)) + "ms"
}

type hostPayloadError struct{ Payload errorPayload }

func (e *hostPayloadError) Error() string { return e.Payload.Message }
func (e *hostPayloadError) Unwrap() error { return payloadCause(e.Payload.Cause) }

// payloadCause rebuilds the Go error a payload layer encodes.
func payloadCause(p *errorPayload) error {
	switch {
	case p == nil:
		return nil
	case p.Kind == "syntax":
		return &moejs.SyntaxError{File: p.File, Line: p.Line, Column: p.Column, Message: p.Message}
	case p.Kind == "memory" && p.Name == "MemoryLimitError":
		return &engine.MemoryLimitError{Limit: deref(p.Limit), Allocated: deref(p.Allocated), Live: deref(p.Live), Stack: deref(p.Stack)}
	}
	for _, s := range sentinels {
		if s.code == p.Code && s.err.Error() == p.Message {
			return s.err
		}
	}
	return &hostPayloadError{*p}
}

// interruptValue is the Interrupt value a host interrupt payload stands for.
func interruptValue(p *errorPayload) any {
	switch {
	case p == nil:
		return nil
	case p.Value == nil && p.Cause != nil && p.Cause.Kind == "budget":
		return errExecutionBudget
	case p.Cause != nil && p.Cause.Kind == "memory" && p.Cause.Name == "MemoryLimitError":
		return payloadCause(p.Cause)
	case p.Value == nil && p.Cause == nil && p.Message == "interrupted":
		return nil
	case p.Cause != nil:
		return &wireInterruptError{*p}
	}
	return wireInterruptReason{*p}
}

func (b *bridge) hostModuleError(p *errorPayload) error {
	if p == nil {
		return wireError("host module request failed")
	}
	return b.hostError(p)
}

func exportedTypeName(err error) string {
	typ := reflect.TypeOf(err)
	if typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if name := typ.Name(); name != "" && name[0] >= 'A' && name[0] <= 'Z' {
		return name
	}
	return ""
}

func (b *bridge) errorPayload(err error) errorPayload { return b.structuredError(err, 0) }

// structuredError encodes each layer from its own type; cause is the next Unwrap layer.
func (b *bridge) structuredError(err error, depth int) errorPayload {
	out := errorPayload{Kind: "bridge", Name: "Error", Message: err.Error()}
	if depth >= 64 {
		return out
	}
	switch e := err.(type) {
	case *hostPayloadError:
		return b.echoPayload(e.Payload)
	case *moejs.InterruptedError:
		switch v := e.Value.(type) {
		case wireInterruptReason:
			return b.echoPayload(v.Payload)
		case *wireInterruptError:
			return b.echoPayload(v.Payload)
		}
		out.Kind, out.Name, out.Code = "interrupted", "InterruptedError", "ERR_INTERRUPTED"
		if _, isError := e.Value.(error); !isError && e.Value != nil {
			// value and reason are decoded separately, so each is its own posted occurrence.
			encodeReason := func() (wireValue, error) {
				switch reason := e.Value.(type) {
				case wireValue:
					return b.echoWire(reason), nil
				case moejs.Value:
					return b.retainValue(reason), nil
				}
				return b.encodeConverted(e.Value)
			}
			value, valueErr := encodeReason()
			reason, reasonErr := encodeReason()
			if valueErr == nil && reasonErr == nil {
				out.Value, out.Reason = &value, &reason
			}
		}
	case *moejs.InternalError:
		if v, ok := e.Value.(*wirePanic); ok {
			return b.echoPayload(v.Payload)
		}
		out.Kind, out.Name, out.Code, out.Stack = "internal", "InternalError", "ERR_INTERNAL", ref(string(e.Stack))
	case *engine.MemoryLimitError:
		out.Kind, out.Name, out.Code = "memory", "MemoryLimitError", "ERR_MEMORY_LIMIT"
		out.Limit, out.Allocated, out.Live, out.Stack = ref(e.Limit), ref(e.Allocated), ref(e.Live), ref(e.Stack)
	case *timeoutError:
		out.Kind, out.Name, out.Code = "timeout", "TimeoutError", "ERR_TIMEOUT"
	case *moejs.Exception:
		out.Kind, out.Name, out.Message = "exception", e.Name(), e.Message()
		if out.Name == "" {
			out.Name = "Error"
		}
		stack := e.Stack
		if b.rt != nil {
			value := b.retainValue(e.Value)
			out.Value = &value
			if trace := b.rt.StackTrace(e); trace != "" {
				stack = trace
			}
		}
		if stack != "" {
			out.Stack = &stack
		}
	case *moejs.SyntaxError:
		out.Kind, out.Name, out.Code, out.Message = "syntax", "SyntaxError", "ERR_SYNTAX", e.Message
		out.File, out.Line, out.Column = e.File, e.Line, e.Column
	case *syntax.Error:
		out.Kind, out.Name, out.Code, out.Message = "syntax", "SyntaxError", "ERR_SYNTAX", e.Message()
		out.File, out.Line, out.Column = e.Name, e.Line, e.Col
	case *compiler.Error:
		out.Kind, out.Name, out.Code, out.Message = "syntax", "SyntaxError", "ERR_SYNTAX", strings.TrimPrefix(e.Msg, "SyntaxError: ")
		out.File, out.Line, out.Column = e.Name, e.Line, e.Col
	case *engine.LinkError:
		out.Line, out.Column, out.Specifier = e.Line, e.Col, e.Specifier
		if e.Module != nil && e.Module.Source != nil {
			out.File = e.Module.Source.Name
		}
		if e.Err == nil {
			out.Kind, out.Name, out.Code = "syntax", "SyntaxError", "ERR_SYNTAX"
		}
	case *moejs.ResolveError:
		out.Name, out.Code = "ResolveError", "ERR_MODULE_RESOLVE"
		out.File, out.Line, out.Column, out.Specifier = e.File, e.Line, e.Column, e.Specifier
	case *moejs.LossyJSONError:
		out.Name, out.Code, out.Path, out.ValueKind = "LossyJSONError", "ERR_LOSSY_JSON", e.Path, e.Value
		out.Omitted, out.Object = e.Omitted, e.Object
	case *json.UnmarshalTypeError:
		out.Name, out.Code, out.Field, out.Offset, out.ValueKind = "UnmarshalTypeError", "ERR_DECODE_TYPE", e.Field, e.Offset, e.Value
		if e.Type != nil {
			out.Target = e.Type.String()
		}
	case *json.InvalidUnmarshalError:
		out.Name, out.Code = "InvalidUnmarshalError", "ERR_DECODE_TARGET"
		if e.Type != nil {
			out.Target = e.Type.String()
		}
	case *targetDecodeError:
		out.Name, out.Code, out.Target = "DecodeTargetError", "ERR_DECODE_TARGET", e.Target
	default:
		matched := false
		for _, s := range sentinels {
			if err == s.err {
				out.Kind, out.Name, out.Code, matched = s.kind, s.name, s.code, true
				if s.code == "ERR_TOO_DEEP" {
					out.Limit = ref(int64(10000))
				}
				break
			}
		}
		if !matched {
			if name := exportedTypeName(err); name != "" {
				out.Name = name
			}
		}
	}
	if cause := errors.Unwrap(err); cause != nil && cause != err {
		encoded := b.structuredError(cause, depth+1)
		out.Cause = &encoded
		if out.Code == "" && encoded.Code != "" {
			out.Code = encoded.Code
			if encoded.Code == "ERR_TOO_DEEP" {
				out.Limit = encoded.Limit
			}
		}
	}
	return out
}

func decodeTargetError(target any, err error) error {
	return &targetDecodeError{Target: fmt.Sprintf("%T", target), Err: err}
}

type targetDecodeError struct {
	Target string
	Err    error
}

func (e *targetDecodeError) Error() string { return e.Err.Error() }
func (e *targetDecodeError) Unwrap() error { return e.Err }

func (b *bridge) payloadNativeError(p *errorPayload) error {
	switch {
	case p == nil:
		return nil
	case p.Kind == "interrupted":
		return &moejs.InterruptedError{Value: interruptValue(p)}
	case p.Kind == "internal":
		return &moejs.InternalError{Value: &wirePanic{*p}, Stack: []byte(deref(p.Stack))}
	case p.Value != nil:
		value, err := b.decode(*p.Value, true, 0)
		if err != nil {
			return err
		}
		return b.rt.Realm().Throw(value)
	}
	return payloadCause(p)
}

// pinPayload holds the guest values a host payload names, so the host may release its handles.
func (b *bridge) pinPayload(p errorPayload) errorPayload {
	if p.Value != nil {
		v := b.pinWire(*p.Value)
		p.Value = &v
	}
	if p.Reason != nil {
		v := b.pinWire(*p.Reason)
		p.Reason = &v
	}
	if p.Cause != nil {
		c := b.pinPayload(*p.Cause)
		p.Cause = &c
	}
	return p
}

// echoPayload re-sends a pinned payload, posting a counted handle for each value it holds.
func (b *bridge) echoPayload(p errorPayload) errorPayload {
	if p.Value != nil {
		v := b.echoWire(*p.Value)
		p.Value = &v
	}
	if p.Reason != nil {
		v := b.echoWire(*p.Reason)
		p.Reason = &v
	}
	if p.Cause != nil {
		c := b.echoPayload(*p.Cause)
		p.Cause = &c
	}
	return p
}

func (b *bridge) pinWire(w wireValue) wireValue {
	return mapWire(w, func(w wireValue) (wireValue, bool) {
		if w.T == "native" {
			if v, ok := b.natives[w.ID]; ok {
				return wireValue{T: "goValue", V: v}, true
			}
			return wireValue{T: "undefined"}, true
		}
		if w.T != "ref" || w.ID == 0 {
			return w, false
		}
		if v, ok := b.values[w.ID]; ok {
			return wireValue{T: "guest", V: v}, true
		}
		return wireValue{T: "undefined"}, true
	})
}

func (b *bridge) echoWire(w wireValue) wireValue {
	return mapWire(w, func(w wireValue) (wireValue, bool) {
		switch v := w.V.(type) {
		case moejs.Value:
			if w.T == "guest" {
				return b.retainValue(v), true
			}
		case reflect.Value:
			if w.T == "goValue" {
				if out, err := b.encodeNative(v); err == nil {
					return out, true
				}
				return wireValue{T: "undefined"}, true
			}
		}
		// An unpinned wire still present is one more posted occurrence.
		if _, ok := b.values[w.ID]; ok && w.T == "ref" && w.ID != 0 {
			b.valueSent[w.ID]++
		} else if _, ok := b.natives[w.ID]; ok && w.T == "native" {
			b.nativeSent[w.ID]++
		}
		return w, false
	})
}

// mapWire rewrites the wire values of a parsed tree; f reports whether it replaced one.
func mapWire(w wireValue, f func(wireValue) (wireValue, bool)) wireValue {
	if out, ok := f(w); ok {
		return out
	}
	var each func(any) any
	each = func(v any) any {
		switch x := v.(type) {
		case wireValue:
			return mapWire(x, f)
		case []any:
			out := make([]any, len(x))
			for i, item := range x {
				out[i] = each(item)
			}
			return out
		}
		return v
	}
	if w.V != nil {
		w.V = each(w.V)
	}
	if w.Root != nil {
		root := mapWire(*w.Root, f)
		w.Root = &root
	}
	return w
}
