//go:build js && wasm

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"reflect"

	"github.com/Calcium-Ion/moejs/bytecode"
	"github.com/Calcium-Ion/moejs/compiler"
	"github.com/Calcium-Ion/moejs/syntax"
)

// These artifacts are private endpoint messages, not a public bytecode API.
// Version the complete schema, including upstream Function's exported fields.
const artifactVersion = "moejs-wasm-bytecode-1\x00"
const maxArtifactBytes = 64 << 20
const maxArtifactItems = 2 << 20
const maxArtifactDepth = 4096

type compilationPayload struct {
	Code      string `json:"code"`
	EarlyCode string `json:"earlyCode"`
	Params    string `json:"params"`
	Body      string `json:"body"`
	Generator bool   `json:"generator"`
	Async     bool   `json:"async"`
	Function  bool   `json:"function"`
}

// Strings are byte strings, not JSON strings: constant pools can contain WTF-8
// and UndefinedCooked. Interning also avoids repeating full source text for each
// nested function. The decoder bounds allocations before making any slice.
type artifactCodec struct {
	data      *bytes.Buffer
	strings   []string
	indexes   map[string]uint32
	items     int
	allocated uint64
	pointers  map[any]uint32
	decoded   []reflect.Value
}

func (c *artifactCodec) put(v reflect.Value, depth int) error {
	c.items++
	if depth > maxArtifactDepth || c.items > maxArtifactItems || c.data.Len() > maxArtifactBytes {
		return fmt.Errorf("bytecode artifact exceeds limits")
	}
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			binary.Write(c.data, binary.LittleEndian, uint32(0))
			return nil
		}
		key := v.Interface()
		if id, ok := c.pointers[key]; ok {
			binary.Write(c.data, binary.LittleEndian, id)
			return nil
		}
		id := uint32(len(c.pointers) + 1)
		c.pointers[key] = id
		binary.Write(c.data, binary.LittleEndian, id)
		return c.put(v.Elem(), depth+1)
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Type().Field(i).IsExported() {
				if err := c.put(v.Field(i), depth+1); err != nil {
					return err
				}
			}
		}
	case reflect.Slice:
		if v.Len() > maxArtifactItems {
			return fmt.Errorf("bytecode artifact exceeds item limit")
		}
		binary.Write(c.data, binary.LittleEndian, uint32(v.Len()))
		for i := range v.Len() {
			if err := c.put(v.Index(i), depth+1); err != nil {
				return err
			}
		}
	case reflect.String:
		s := v.String()
		if id, ok := c.indexes[s]; ok {
			binary.Write(c.data, binary.LittleEndian, id)
			return nil
		}
		if len(s) > maxArtifactBytes {
			return fmt.Errorf("bytecode string exceeds limit")
		}
		id := uint32(len(c.indexes) + 1)
		c.indexes[s] = id
		binary.Write(c.data, binary.LittleEndian, id)
		binary.Write(c.data, binary.LittleEndian, uint32(len(s)))
		c.data.WriteString(s)
	case reflect.Bool:
		if v.Bool() {
			c.data.WriteByte(1)
		} else {
			c.data.WriteByte(0)
		}
	case reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uint:
		binary.Write(c.data, binary.LittleEndian, v.Uint())
	case reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Int:
		binary.Write(c.data, binary.LittleEndian, v.Int())
	case reflect.Float64:
		binary.Write(c.data, binary.LittleEndian, math.Float64bits(v.Float()))
	default:
		return fmt.Errorf("unsupported bytecode field %s", v.Type())
	}
	return nil
}

func (c *artifactCodec) get(v reflect.Value, depth int) error {
	c.items++
	if depth > maxArtifactDepth || c.items > maxArtifactItems {
		return fmt.Errorf("bytecode artifact exceeds limits")
	}
	switch v.Kind() {
	case reflect.Pointer:
		var id uint32
		if err := binary.Read(c.data, binary.LittleEndian, &id); err != nil {
			return err
		}
		if id == 0 {
			return nil
		}
		if int(id) <= len(c.decoded) {
			previous := c.decoded[id-1]
			if !previous.IsValid() || previous.Type() != v.Type() {
				return fmt.Errorf("invalid or cyclic bytecode pointer")
			}
			v.Set(previous)
			return nil
		}
		if int(id) != len(c.decoded)+1 {
			return fmt.Errorf("invalid bytecode pointer reference")
		}
		c.allocated += uint64(v.Type().Elem().Size())
		if c.allocated > maxArtifactBytes {
			return fmt.Errorf("bytecode exceeds memory limit")
		}
		c.decoded = append(c.decoded, reflect.Value{})
		v.Set(reflect.New(v.Type().Elem()))
		if err := c.get(v.Elem(), depth+1); err != nil {
			return err
		}
		c.decoded[id-1] = reflect.ValueOf(v.Interface())
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Type().Field(i).IsExported() {
				if err := c.get(v.Field(i), depth+1); err != nil {
					return err
				}
			}
		}
	case reflect.Slice:
		var n uint32
		if err := binary.Read(c.data, binary.LittleEndian, &n); err != nil {
			return err
		}
		if int(n) > c.data.Len() || int(n) > maxArtifactItems-c.items {
			return fmt.Errorf("invalid bytecode slice size")
		}
		// Bound allocated memory as well as serialized size (structs may be large).
		c.allocated += uint64(n) * uint64(v.Type().Elem().Size())
		if c.allocated > maxArtifactBytes {
			return fmt.Errorf("bytecode exceeds memory limit")
		}
		v.Set(reflect.MakeSlice(v.Type(), int(n), int(n)))
		for i := range int(n) {
			if err := c.get(v.Index(i), depth+1); err != nil {
				return err
			}
		}
	case reflect.String:
		var id uint32
		if err := binary.Read(c.data, binary.LittleEndian, &id); err != nil {
			return err
		}
		if id == 0 || int(id) > len(c.strings)+1 {
			return fmt.Errorf("invalid bytecode string reference")
		}
		if int(id) <= len(c.strings) {
			v.SetString(c.strings[id-1])
			return nil
		}
		var n uint32
		if err := binary.Read(c.data, binary.LittleEndian, &n); err != nil {
			return err
		}
		if uint64(n) > uint64(c.data.Len()) {
			return io.ErrUnexpectedEOF
		}
		c.allocated += uint64(n)
		if c.allocated > maxArtifactBytes {
			return fmt.Errorf("bytecode exceeds memory limit")
		}
		s := string(c.data.Next(int(n)))
		c.strings = append(c.strings, s)
		v.SetString(s)
	case reflect.Bool:
		x, err := c.data.ReadByte()
		if err != nil {
			return err
		}
		if x > 1 {
			return fmt.Errorf("invalid bytecode boolean")
		}
		v.SetBool(x == 1)
	case reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uint:
		var x uint64
		if err := binary.Read(c.data, binary.LittleEndian, &x); err != nil {
			return err
		}
		if v.OverflowUint(x) {
			return fmt.Errorf("bytecode integer overflow")
		}
		v.SetUint(x)
	case reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Int:
		var x int64
		if err := binary.Read(c.data, binary.LittleEndian, &x); err != nil {
			return err
		}
		if v.OverflowInt(x) {
			return fmt.Errorf("bytecode integer overflow")
		}
		v.SetInt(x)
	case reflect.Float64:
		var x uint64
		if err := binary.Read(c.data, binary.LittleEndian, &x); err != nil {
			return err
		}
		v.SetFloat(math.Float64frombits(x))
	default:
		return fmt.Errorf("unsupported bytecode field %s", v.Type())
	}
	return nil
}

func verifyArtifact(fn *bytecode.Function, depth int) error {
	if fn == nil || depth > maxArtifactDepth {
		return fmt.Errorf("invalid bytecode function tree")
	}
	if fn.Kind > bytecode.KindDerivedCtor || fn.Length < 0 {
		return fmt.Errorf("invalid bytecode function metadata")
	}
	if fn.Source == nil || fn.Source.Start < 0 || fn.Source.End < fn.Source.Start || fn.Source.End > len(fn.Source.Src) {
		return fmt.Errorf("invalid bytecode source range")
	}
	if err := bytecode.VerifyRegisters(fn); err != nil {
		return err
	}
	if fn.Extra != nil {
		for _, scope := range fn.Extra.Evals {
			if scope == nil {
				return fmt.Errorf("invalid eval scope")
			}
			levels := 0
			for l := scope.Env; l != nil; l = l.Outer {
				levels++
				if levels > maxArtifactDepth || len(l.Names) != len(l.Kinds) || len(l.Names) != len(l.TDZ) {
					return fmt.Errorf("invalid eval environment")
				}
			}
			if scope.Var < -1 || scope.Var >= levels || scope.This < -1 || scope.This >= levels || scope.Fields < -1 || scope.Fields >= levels {
				return fmt.Errorf("invalid eval environment index")
			}
		}
	}
	if fn.Module != nil {
		for _, e := range fn.Module.Exports {
			if e.Slot < 0 || e.Slot >= len(fn.CaptureLayout) {
				return fmt.Errorf("invalid export slot")
			}
		}
		if l := fn.Module.Links; l != nil {
			valid := func(i int) bool { return i >= 0 && i < len(l.Requests) }
			for _, e := range l.Imports {
				if !valid(e.Request) || e.Slot < 0 || e.Slot >= len(fn.CaptureLayout) {
					return fmt.Errorf("invalid import binding")
				}
			}
			for _, e := range l.Reexports {
				if !valid(e.Request) {
					return fmt.Errorf("invalid reexport")
				}
			}
			for _, e := range l.Stars {
				if !valid(e.Request) {
					return fmt.Errorf("invalid star export")
				}
			}
		}
	}
	for _, child := range fn.Children {
		if err := verifyArtifact(child, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func encodeArtifact(fn *bytecode.Function) (string, error) {
	if err := verifyArtifact(fn, 0); err != nil {
		return "", err
	}
	c := artifactCodec{data: new(bytes.Buffer), indexes: make(map[string]uint32), pointers: make(map[any]uint32)}
	c.data.WriteString(artifactVersion)
	if err := c.put(reflect.ValueOf(fn), 0); err != nil {
		return "", err
	}
	if c.data.Len() > maxArtifactBytes {
		return "", fmt.Errorf("bytecode artifact exceeds limits")
	}
	return base64.StdEncoding.EncodeToString(c.data.Bytes()), nil
}

func decodeArtifact(text string, kind bytecode.Kind) (*bytecode.Function, error) {
	if len(text) > base64.StdEncoding.EncodedLen(maxArtifactBytes) {
		return nil, fmt.Errorf("bytecode artifact exceeds limits")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(text)
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(data, []byte(artifactVersion)) {
		return nil, fmt.Errorf("unsupported bytecode artifact version")
	}
	c := artifactCodec{data: bytes.NewBuffer(data[len(artifactVersion):])}
	var fn *bytecode.Function
	if err := c.get(reflect.ValueOf(&fn).Elem(), 0); err != nil {
		return nil, err
	}
	if c.data.Len() != 0 {
		return nil, fmt.Errorf("trailing bytecode artifact data")
	}
	if err := verifyArtifact(fn, 0); err != nil {
		return nil, err
	}
	if fn.Kind != kind || (kind == bytecode.KindModule && fn.Module == nil) {
		return nil, fmt.Errorf("incorrect bytecode artifact kind")
	}
	return fn, nil
}

func (b *bridge) compilePrepared(p payload) (*compiledModule, error) {
	if mod := b.modules[p.ModuleID]; mod != nil {
		return mod, nil
	}
	var code, early *bytecode.Function
	var err error
	if p.Code != "" {
		code, err = decodeArtifact(p.Code, bytecode.KindModule)
		if err == nil {
			early, err = decodeArtifact(p.EarlyCode, bytecode.KindModule)
		}
	} else {
		if b.rt != nil {
			return nil, wireError("compiled module bytecode is required")
		}
		var parsed *syntax.Module
		parsed, err = syntax.ParseModule(p.Name, p.Source, syntax.Options{TypeScript: p.TypeScript, Stop: b.stopCompile})
		if err == nil {
			code, err = compiler.CompileModuleStop(parsed, b.stopCompile)
		}
		if err == nil {
			parsed, err = syntax.ParseModule(p.Name, p.Source, syntax.Options{TypeScript: p.TypeScript, EarlyExports: true, Stop: b.stopCompile})
		}
		if err == nil {
			early, err = compiler.CompileModuleStop(parsed, b.stopCompile)
		}
	}
	if err != nil {
		return nil, err
	}
	mod := &compiledModule{code: code, name: code.Source.Name, exports: make([]string, len(code.Module.Exports)), requests: []string{}}
	mod.early = early
	mod.codeWire, mod.earlyWire = p.Code, p.EarlyCode
	for i, e := range code.Module.Exports {
		mod.exports[i] = e.Name
	}
	if code.Module.Links != nil {
		for _, r := range code.Module.Links.Requests {
			mod.requests = append(mod.requests, r.Specifier)
		}
	}
	b.modules[p.ModuleID] = mod
	b.registerModule(mod, p)
	return mod, nil
}

func (b *bridge) compileScriptPrepared(p payload) (*bytecode.Function, error) {
	if code := b.scripts[p.ScriptID]; code != nil {
		return code, nil
	}
	var code *bytecode.Function
	var err error
	if p.Code != "" {
		code, err = decodeArtifact(p.Code, bytecode.KindScript)
	} else {
		if b.rt != nil {
			return nil, wireError("compiled script bytecode is required")
		}
		if p.Function {
			code, err = compiler.CompileFunction(p.Name, p.Params, p.Body, p.Generator, p.Async, p.TypeScript, b.stopCompile)
		} else {
			var parsed *syntax.Script
			parsed, err = syntax.ParseScript(p.Name, p.Source, syntax.Options{TypeScript: p.TypeScript, Stop: b.stopCompile})
			if err == nil {
				code, err = compiler.CompileScriptStop(parsed, b.stopCompile)
			}
		}
	}
	if err != nil {
		return nil, err
	}
	b.scripts[p.ScriptID] = code
	return code, nil
}

func moduleMetadata(mod *compiledModule) (map[string]any, error) {
	var err error
	if mod.codeWire == "" {
		mod.codeWire, err = encodeArtifact(mod.code)
		if err != nil {
			return nil, err
		}
	}
	if mod.earlyWire == "" {
		mod.earlyWire, err = encodeArtifact(mod.early)
		if err != nil {
			return nil, err
		}
	}
	locations := make(map[string]any)
	if links := mod.code.Module.Links; links != nil {
		for _, req := range links.Requests {
			locations[req.Specifier] = map[string]any{"line": req.Line, "column": req.Col}
		}
	}
	return map[string]any{"name": mod.name, "exports": mod.exports, "requests": mod.requests, "requestLocations": locations, "code": mod.codeWire, "earlyCode": mod.earlyWire}, nil
}

func scriptMetadata(code *bytecode.Function) (map[string]any, error) {
	data, err := encodeArtifact(code)
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": code.Source.Name, "code": data}, nil
}
