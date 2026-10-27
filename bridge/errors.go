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
	"github.com/Calcium-Ion/moejs/syntax"
)

type errorPayload struct {
	Kind      string        `json:"kind"`
	Name      string        `json:"name"`
	Message   string        `json:"message"`
	Stack     string        `json:"stack,omitempty"`
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
	Limit     int64         `json:"limit,omitempty"`
	Allocated int64         `json:"allocated,omitempty"`
	Live      int64         `json:"live,omitempty"`
	Omitted   bool          `json:"omitted,omitempty"`
	Object    bool          `json:"object,omitempty"`
	Target    string        `json:"target,omitempty"`
	Field     string        `json:"field,omitempty"`
	Offset    int64         `json:"offset,omitempty"`
}

// wireInterruptReason is immutable wire data: the interrupt thread never enters the realm.
type wireInterruptReason struct{ Value wireValue }

func (wireInterruptReason) Error() string { return "host interrupt" }

type hostPayloadError struct{ Payload errorPayload }

func (e *hostPayloadError) Error() string { return e.Payload.Message }
func (e *hostPayloadError) Unwrap() error {
	if e.Payload.Cause == nil {
		return nil
	}
	return &hostPayloadError{*e.Payload.Cause}
}
func (b *bridge) hostModuleError(p *errorPayload) error {
	if p == nil {
		return wireError("host module request failed")
	}
	if p.Value != nil {
		return b.hostError(p)
	}
	return &hostPayloadError{*p}
}

func (b *bridge) errorPayload(err error) errorPayload { return b.structuredError(err, 0) }
func (b *bridge) structuredError(err error, depth int) errorPayload {
	out := errorPayload{Kind: "bridge", Name: "Error", Message: err.Error()}
	if depth >= 64 {
		return out
	}
	if host, ok := err.(*hostPayloadError); ok {
		return host.Payload
	}
	var syntaxError *moejs.SyntaxError
	var parserError *syntax.Error
	var compilerError *compiler.Error
	var exception *moejs.Exception
	var internal *moejs.InternalError
	var interrupted *moejs.InterruptedError
	var linkError *engine.LinkError
	var resolveError *moejs.ResolveError
	var lossy *moejs.LossyJSONError
	var memory *engine.MemoryLimitError
	var target *targetDecodeError
	var unmarshalType *json.UnmarshalTypeError
	var invalidTarget *json.InvalidUnmarshalError
	switch {
	case errors.Is(err, errExecutionBudget):
		out.Kind, out.Name, out.Code = "budget", "ExecutionBudgetError", "ERR_EXECUTION_BUDGET"
	case errors.As(err, &memory):
		out.Kind, out.Name, out.Code = "memory", "MemoryLimitError", "ERR_MEMORY_LIMIT"
		out.Limit, out.Allocated, out.Live, out.Stack = memory.Limit, memory.Allocated, memory.Live, memory.Stack
	case errors.Is(err, moejs.ErrMemoryLimit):
		out.Kind, out.Name, out.Code = "memory", "MemoryLimitError", "ERR_MEMORY_LIMIT"
	case errors.As(err, &interrupted):
		out.Kind, out.Name, out.Code = "interrupted", "InterruptedError", "ERR_INTERRUPTED"
		var value wireValue
		var encodeErr error
		switch reason := interrupted.Value.(type) {
		case wireInterruptReason:
			value = reason.Value
		case *wireInterruptReason:
			value = reason.Value
		case wireValue:
			value = reason
		case moejs.Value:
			value = b.retainValue(reason)
		default:
			value, encodeErr = b.encodeConverted(reason)
		}
		if encodeErr == nil {
			out.Value, out.Reason = &value, &value
		}
	case errors.As(err, &target):
		out.Name, out.Code, out.Target = "DecodeTargetError", "ERR_DECODE_TARGET", target.Target
	case errors.As(err, &resolveError):
		out.Name, out.Code = "ResolveError", "ERR_MODULE_RESOLVE"
		out.File, out.Line, out.Column, out.Specifier = resolveError.File, resolveError.Line, resolveError.Column, resolveError.Specifier
	case errors.As(err, &lossy):
		out.Name, out.Code, out.Path, out.ValueKind = "LossyJSONError", "ERR_LOSSY_JSON", lossy.Path, lossy.Value
		out.Omitted, out.Object = lossy.Omitted, lossy.Object
	case errors.As(err, &unmarshalType):
		out.Name, out.Code, out.Field, out.Offset, out.ValueKind = "UnmarshalTypeError", "ERR_DECODE_TYPE", unmarshalType.Field, unmarshalType.Offset, unmarshalType.Value
		if unmarshalType.Type != nil {
			out.Target = unmarshalType.Type.String()
		}
	case errors.As(err, &invalidTarget):
		out.Name, out.Code = "InvalidUnmarshalError", "ERR_DECODE_TARGET"
		if invalidTarget.Type != nil {
			out.Target = invalidTarget.Type.String()
		}
	case errors.As(err, &syntaxError):
		out.Kind, out.Name, out.Message = "syntax", "SyntaxError", syntaxError.Message
		out.File, out.Line, out.Column = syntaxError.File, syntaxError.Line, syntaxError.Column
	case errors.As(err, &parserError):
		out.Kind, out.Name, out.Message = "syntax", "SyntaxError", parserError.Message()
		out.File, out.Line, out.Column = parserError.Name, parserError.Line, parserError.Col
	case errors.As(err, &compilerError):
		out.Kind, out.Name, out.Message = "syntax", "SyntaxError", strings.TrimPrefix(compilerError.Msg, "SyntaxError: ")
		out.File, out.Line, out.Column = compilerError.Name, compilerError.Line, compilerError.Col
	case errors.As(err, &linkError):
		out.Line, out.Column, out.Specifier = linkError.Line, linkError.Col, linkError.Specifier
		if linkError.Module != nil && linkError.Module.Source != nil {
			out.File = linkError.Module.Source.Name
		}
		if linkError.Err == nil {
			out.Kind, out.Name = "syntax", "SyntaxError"
		}
	case errors.As(err, &internal):
		out.Kind, out.Name, out.Stack = "internal", "InternalError", string(internal.Stack)
	case errors.As(err, &exception):
		out.Kind, out.Name, out.Message = "exception", exception.Name(), exception.Message()
		if out.Name == "" {
			out.Name = "Error"
		}
		if b.rt != nil {
			value := b.retainValue(exception.Value)
			out.Value = &value
		}
		out.Stack = exception.Stack
		if b.rt != nil {
			if stack := b.rt.StackTrace(exception); stack != "" {
				out.Stack = stack
			}
		}
	default:
		typ := reflect.TypeOf(err)
		if typ != nil {
			if typ.Kind() == reflect.Pointer {
				typ = typ.Elem()
			}
			if typ.Name() != "" {
				out.Name = typ.Name()
			}
		}
	}
	if errors.Is(err, moejs.ErrTooDeep) {
		out.Code = "ERR_TOO_DEEP"
		out.Limit = 10000
	}
	if cause := errors.Unwrap(err); cause != nil && cause != err {
		encoded := b.structuredError(cause, depth+1)
		out.Cause = &encoded
	}
	if errors.Is(err, moejs.ErrTooLarge) {
		out.Code = "ERR_DECODE_LIMIT"
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
	if p == nil {
		return nil
	}
	switch p.Kind {
	case "budget":
		return &moejs.InterruptedError{Value: errExecutionBudget}
	case "memory":
		return &moejs.InterruptedError{Value: &engine.MemoryLimitError{Limit: p.Limit, Allocated: p.Allocated, Live: p.Live, Stack: p.Stack}}
	case "timeout":
		return &moejs.InterruptedError{Value: &hostPayloadError{*p}}
	case "exception":
		return b.hostError(p)
	case "interrupted":
		if p.Reason != nil {
			return &moejs.InterruptedError{Value: wireInterruptReason{*p.Reason}}
		}
		if p.Value != nil {
			return &moejs.InterruptedError{Value: wireInterruptReason{*p.Value}}
		}
		return &moejs.InterruptedError{Value: p.Message}
	case "internal":
		return &moejs.InternalError{Value: p.Message, Stack: []byte(p.Stack)}
	}
	return &hostPayloadError{*p}
}
