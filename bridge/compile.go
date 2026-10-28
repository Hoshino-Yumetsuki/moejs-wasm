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
	"sync"
	"unsafe"

	"github.com/Calcium-Ion/moejs/bytecode"
	"github.com/Calcium-Ion/moejs/compiler"
	"github.com/Calcium-Ion/moejs/syntax"
)

// These artifacts are private endpoint messages, not a public bytecode API.
// Version the complete schema, including upstream Function's exported fields.
const artifactVersion = "moejs-wasm-bytecode-2\x00"

// A 9MB bundle encodes to about 18MB and 3M items, and decodes to 35MB.
const maxArtifactBytes = 256 << 20
const maxArtifactItems = maxArtifactBytes
const maxArtifactMemory = 1 << 30

const maxArtifactDepth = 1 << 15

type compilationPayload struct {
	Code       string  `json:"code"`
	EarlyCode  string  `json:"earlyCode"`
	Params     string  `json:"params"`
	Body       string  `json:"body"`
	Generator  bool    `json:"generator"`
	Async      bool    `json:"async"`
	Function   bool    `json:"function"`
	DeadlineAt float64 `json:"deadlineAt"`
	DeadlineMs float64 `json:"deadlineMs"`
}

// Strings are byte strings, not JSON strings: constant pools can contain WTF-8
// and UndefinedCooked. Interning also avoids repeating full source text for each
// nested function. The decoder bounds allocations before making any slice.
type artifactCodec struct {
	data      []byte
	pos       int
	strings   []string
	indexes   map[string]uint32
	shared    map[sharedString]uint32
	items     int
	allocated uint64
	pointers  map[any]uint32
	decoded   []reflect.Value
	fields    map[reflect.Type][]int
}

type sharedString struct {
	data *byte
	len  int
}

func (c *artifactCodec) exportedFields(t reflect.Type) []int {
	if fields, ok := c.fields[t]; ok {
		return fields
	}
	fields := []int{}
	for i := range t.NumField() {
		if t.Field(i).IsExported() {
			fields = append(fields, i)
		}
	}
	if c.fields == nil {
		c.fields = make(map[reflect.Type][]int)
	}
	c.fields[t] = fields
	return fields
}

var (
	byteSlice   = reflect.TypeFor[[]uint8]()
	uint16Slice = reflect.TypeFor[[]uint16]()
	uint32Slice = reflect.TypeFor[[]uint32]()
)

func (c *artifactCodec) put(v reflect.Value, depth int) error {
	if err := c.within(1, depth); err != nil {
		return err
	}
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			c.data = append(c.data, 0)
			return nil
		}
		key := v.Interface()
		if id, ok := c.pointers[key]; ok {
			c.data = binary.AppendUvarint(c.data, uint64(id))
			return nil
		}
		id := uint32(len(c.pointers) + 1)
		c.pointers[key] = id
		c.data = binary.AppendUvarint(c.data, uint64(id))
		return c.put(v.Elem(), depth+1)
	case reflect.Struct:
		for _, i := range c.exportedFields(v.Type()) {
			if err := c.put(v.Field(i), depth+1); err != nil {
				return err
			}
		}
	case reflect.Slice:
		if err := c.putLen(v.Len()); err != nil {
			return err
		}
		switch t := v.Type(); {
		case t == lineEntrySlice && fastLineEntries:
			return c.putLineEntries(v.Interface().([]bytecode.LineEntry), depth)
		case t == constSlice && fastConsts:
			return c.putConsts(v.Interface().([]bytecode.Const), depth)
		case t.ConvertibleTo(byteSlice):
			c.data = append(c.data, v.Convert(byteSlice).Bytes()...)
		case t.ConvertibleTo(uint16Slice):
			c.putUint16s(v.Convert(uint16Slice).Interface().([]uint16))
		case t.ConvertibleTo(uint32Slice):
			for _, x := range v.Convert(uint32Slice).Interface().([]uint32) {
				c.data = binary.LittleEndian.AppendUint32(c.data, x)
			}
		default:
			for i := range v.Len() {
				if err := c.put(v.Index(i), depth+1); err != nil {
					return err
				}
			}
		}
	case reflect.String:
		return c.putString(v.String())
	case reflect.Bool:
		c.putBool(v.Bool())
	case reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uint:
		c.data = binary.AppendUvarint(c.data, v.Uint())
	case reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Int:
		c.data = binary.AppendVarint(c.data, v.Int())
	case reflect.Float64:
		c.data = binary.LittleEndian.AppendUint64(c.data, math.Float64bits(v.Float()))
	default:
		return fmt.Errorf("unsupported bytecode field %s", v.Type())
	}
	return nil
}

const sharedStringBytes = 128

func (c *artifactCodec) putString(s string) error {
	// Each SourceInfo shares the source text; hashing it per function is quadratic.
	long := len(s) >= sharedStringBytes
	ref := sharedString{unsafe.StringData(s), len(s)}
	if long {
		if id, ok := c.shared[ref]; ok {
			c.data = binary.AppendUvarint(c.data, uint64(id))
			return nil
		}
	}
	if id, ok := c.indexes[s]; ok {
		if long {
			c.shared[ref] = id
		}
		c.data = binary.AppendUvarint(c.data, uint64(id))
		return nil
	}
	if len(s) > maxArtifactBytes {
		return fmt.Errorf("bytecode string exceeds limit")
	}
	id := uint32(len(c.indexes) + 1)
	c.indexes[s] = id
	if long {
		c.shared[ref] = id
	}
	c.data = binary.AppendUvarint(c.data, uint64(id))
	c.data = binary.AppendUvarint(c.data, uint64(len(s)))
	c.data = append(c.data, s...)
	return nil
}

func (c *artifactCodec) putBool(b bool) {
	if b {
		c.data = append(c.data, 1)
	} else {
		c.data = append(c.data, 0)
	}
}

// These fast paths must write the reflective walk's bytes and item counts.
var (
	lineEntrySlice  = reflect.TypeFor[[]bytecode.LineEntry]()
	constSlice      = reflect.TypeFor[[]bytecode.Const]()
	fastLineEntries = hasFields(reflect.TypeFor[bytecode.LineEntry](), "PC uint32", "Line int32", "Col int32")
	fastConsts      = hasFields(reflect.TypeFor[bytecode.Const](), "Kind bytecode.ConstKind", "Num float64", "Str string", "IsASCII bool", "Units []uint16", "Key bool", "Flags string", "Cooked []string", "Raw []string", "Index int")
)

func hasFields(t reflect.Type, fields ...string) bool {
	if t.NumField() != len(fields) {
		return false
	}
	for i, want := range fields {
		if f := t.Field(i); !f.IsExported() || f.Name+" "+f.Type.String() != want {
			return false
		}
	}
	return true
}

var errArtifactLimits = fmt.Errorf("bytecode artifact exceeds limits")

func (c *artifactCodec) within(items, depth int) error {
	c.items += items
	if depth > maxArtifactDepth || c.items > maxArtifactItems || len(c.data) > maxArtifactBytes {
		return errArtifactLimits
	}
	return nil
}

func (c *artifactCodec) putLen(n int) error {
	if n > maxArtifactItems {
		return errArtifactLimits
	}
	c.data = binary.AppendUvarint(c.data, uint64(n))
	return nil
}

func (c *artifactCodec) putUint16s(units []uint16) {
	for _, u := range units {
		c.data = binary.LittleEndian.AppendUint16(c.data, u)
	}
}

func (c *artifactCodec) getUint16s(n int) ([]uint16, error) {
	run, err := c.fixed(n, 2)
	if err != nil {
		return nil, err
	}
	units := make([]uint16, n)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(run[2*i:])
	}
	return units, nil
}

func (c *artifactCodec) putLineEntries(entries []bytecode.LineEntry, depth int) error {
	for _, e := range entries {
		if err := c.within(4, depth+2); err != nil {
			return err
		}
		c.data = binary.AppendUvarint(c.data, uint64(e.PC))
		c.data = binary.AppendVarint(c.data, int64(e.Line))
		c.data = binary.AppendVarint(c.data, int64(e.Col))
	}
	return nil
}

func (c *artifactCodec) putConsts(consts []bytecode.Const, depth int) error {
	for i := range consts {
		k := &consts[i]
		if err := c.within(11, depth+2); err != nil {
			return err
		}
		c.data = binary.AppendUvarint(c.data, uint64(k.Kind))
		c.data = binary.LittleEndian.AppendUint64(c.data, math.Float64bits(k.Num))
		if err := c.putString(k.Str); err != nil {
			return err
		}
		c.putBool(k.IsASCII)
		if err := c.putLen(len(k.Units)); err != nil {
			return err
		}
		c.putUint16s(k.Units)
		c.putBool(k.Key)
		if err := c.putString(k.Flags); err != nil {
			return err
		}
		for _, list := range [2][]string{k.Cooked, k.Raw} {
			if err := c.putLen(len(list)); err != nil {
				return err
			}
			for _, item := range list {
				if err := c.within(1, depth+3); err != nil {
					return err
				}
				if err := c.putString(item); err != nil {
					return err
				}
			}
		}
		c.data = binary.AppendVarint(c.data, int64(k.Index))
	}
	return nil
}

func (c *artifactCodec) getString() (string, error) {
	id, err := c.uvarint()
	if err != nil {
		return "", err
	}
	if id == 0 || id > uint64(len(c.strings))+1 {
		return "", fmt.Errorf("invalid bytecode string reference")
	}
	if id <= uint64(len(c.strings)) {
		return c.strings[id-1], nil
	}
	n, err := c.uvarint()
	if err != nil {
		return "", err
	}
	if n > uint64(c.remaining()) {
		return "", io.ErrUnexpectedEOF
	}
	if err := c.alloc(n); err != nil {
		return "", err
	}
	s := string(c.data[c.pos : c.pos+int(n)])
	c.pos += int(n)
	c.strings = append(c.strings, s)
	return s, nil
}

func (c *artifactCodec) getBool() (bool, error) {
	if c.remaining() < 1 {
		return false, io.ErrUnexpectedEOF
	}
	x := c.data[c.pos]
	c.pos++
	if x > 1 {
		return false, fmt.Errorf("invalid bytecode boolean")
	}
	return x == 1, nil
}

func (c *artifactCodec) varint() (int64, error) {
	x, n := binary.Varint(c.data[c.pos:])
	if n <= 0 {
		return 0, io.ErrUnexpectedEOF
	}
	c.pos += n
	return x, nil
}

var errArtifactOverflow = fmt.Errorf("bytecode integer overflow")

func (c *artifactCodec) getLineEntries(n, depth int) ([]bytecode.LineEntry, error) {
	entries := make([]bytecode.LineEntry, n)
	for i := range entries {
		if err := c.within(4, depth+2); err != nil {
			return nil, err
		}
		pc, err := c.uvarint()
		if err != nil {
			return nil, err
		}
		line, err := c.varint()
		if err != nil {
			return nil, err
		}
		col, err := c.varint()
		if err != nil {
			return nil, err
		}
		if pc > math.MaxUint32 || line != int64(int32(line)) || col != int64(int32(col)) {
			return nil, errArtifactOverflow
		}
		entries[i] = bytecode.LineEntry{PC: uint32(pc), Line: int32(line), Col: int32(col)}
	}
	return entries, nil
}

func (c *artifactCodec) count(size uintptr) (int, error) {
	n, err := c.uvarint()
	if err != nil {
		return 0, err
	}
	if n > uint64(c.remaining()) || n > uint64(maxArtifactItems-c.items) {
		return 0, fmt.Errorf("invalid bytecode slice size")
	}
	if err := c.alloc(n * uint64(size)); err != nil {
		return 0, err
	}
	return int(n), nil
}

var errArtifactMemory = fmt.Errorf("bytecode exceeds memory limit")

// Bound allocated memory as well as serialized size (structs may be large).
func (c *artifactCodec) alloc(bytes uint64) error {
	c.allocated += bytes
	if c.allocated > maxArtifactMemory {
		return errArtifactMemory
	}
	return nil
}

func (c *artifactCodec) getConsts(n, depth int) ([]bytecode.Const, error) {
	consts := make([]bytecode.Const, n)
	for i := range consts {
		k := &consts[i]
		if err := c.within(11, depth+2); err != nil {
			return nil, err
		}
		kind, err := c.uvarint()
		if err != nil {
			return nil, err
		}
		if kind > math.MaxUint8 {
			return nil, errArtifactOverflow
		}
		k.Kind = bytecode.ConstKind(kind)
		num, err := c.fixed(1, 8)
		if err != nil {
			return nil, err
		}
		k.Num = math.Float64frombits(binary.LittleEndian.Uint64(num))
		if k.Str, err = c.getString(); err != nil {
			return nil, err
		}
		if k.IsASCII, err = c.getBool(); err != nil {
			return nil, err
		}
		units, err := c.count(2)
		if err != nil {
			return nil, err
		}
		if k.Units, err = c.getUint16s(units); err != nil {
			return nil, err
		}
		if k.Key, err = c.getBool(); err != nil {
			return nil, err
		}
		if k.Flags, err = c.getString(); err != nil {
			return nil, err
		}
		for _, list := range [2]*[]string{&k.Cooked, &k.Raw} {
			size, err := c.count(unsafe.Sizeof(""))
			if err != nil {
				return nil, err
			}
			*list = make([]string, size)
			for j := range *list {
				if err := c.within(1, depth+3); err != nil {
					return nil, err
				}
				if (*list)[j], err = c.getString(); err != nil {
					return nil, err
				}
			}
		}
		index, err := c.varint()
		if err != nil {
			return nil, err
		}
		k.Index = int(index)
	}
	return consts, nil
}

func (c *artifactCodec) remaining() int { return len(c.data) - c.pos }

func (c *artifactCodec) uvarint() (uint64, error) {
	x, n := binary.Uvarint(c.data[c.pos:])
	if n <= 0 {
		return 0, io.ErrUnexpectedEOF
	}
	c.pos += n
	return x, nil
}

func (c *artifactCodec) fixed(n, size int) ([]byte, error) {
	if n > c.remaining()/size {
		return nil, io.ErrUnexpectedEOF
	}
	run := c.data[c.pos : c.pos+n*size]
	c.pos += n * size
	return run, nil
}

func (c *artifactCodec) get(v reflect.Value, depth int) error {
	if err := c.within(1, depth); err != nil {
		return err
	}
	switch v.Kind() {
	case reflect.Pointer:
		id, err := c.uvarint()
		if err != nil {
			return err
		}
		if id == 0 {
			return nil
		}
		if id <= uint64(len(c.decoded)) {
			previous := c.decoded[id-1]
			if !previous.IsValid() || previous.Type() != v.Type() {
				return fmt.Errorf("invalid or cyclic bytecode pointer")
			}
			v.Set(previous)
			return nil
		}
		if id != uint64(len(c.decoded))+1 {
			return fmt.Errorf("invalid bytecode pointer reference")
		}
		if err := c.alloc(uint64(v.Type().Elem().Size())); err != nil {
			return err
		}
		c.decoded = append(c.decoded, reflect.Value{})
		v.Set(reflect.New(v.Type().Elem()))
		if err := c.get(v.Elem(), depth+1); err != nil {
			return err
		}
		c.decoded[id-1] = reflect.ValueOf(v.Interface())
	case reflect.Struct:
		for _, i := range c.exportedFields(v.Type()) {
			if err := c.get(v.Field(i), depth+1); err != nil {
				return err
			}
		}
	case reflect.Slice:
		n, err := c.count(v.Type().Elem().Size())
		if err != nil {
			return err
		}
		switch t := v.Type(); {
		case t == lineEntrySlice && fastLineEntries:
			entries, err := c.getLineEntries(n, depth)
			if err != nil {
				return err
			}
			v.Set(reflect.ValueOf(entries))
		case t == constSlice && fastConsts:
			consts, err := c.getConsts(n, depth)
			if err != nil {
				return err
			}
			v.Set(reflect.ValueOf(consts))
		case t.ConvertibleTo(byteSlice):
			run, err := c.fixed(n, 1)
			if err != nil {
				return err
			}
			v.Set(reflect.ValueOf(bytes.Clone(run)).Convert(t))
		case t.ConvertibleTo(uint16Slice):
			units, err := c.getUint16s(n)
			if err != nil {
				return err
			}
			v.Set(reflect.ValueOf(units).Convert(t))
		case t.ConvertibleTo(uint32Slice):
			run, err := c.fixed(n, 4)
			if err != nil {
				return err
			}
			out := make([]uint32, n)
			for i := range out {
				out[i] = binary.LittleEndian.Uint32(run[4*i:])
			}
			v.Set(reflect.ValueOf(out).Convert(t))
		default:
			v.Set(reflect.MakeSlice(t, n, n))
			for i := range n {
				if err := c.get(v.Index(i), depth+1); err != nil {
					return err
				}
			}
		}
	case reflect.String:
		s, err := c.getString()
		if err != nil {
			return err
		}
		v.SetString(s)
	case reflect.Bool:
		b, err := c.getBool()
		if err != nil {
			return err
		}
		v.SetBool(b)
	case reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uint:
		x, err := c.uvarint()
		if err != nil {
			return err
		}
		if v.OverflowUint(x) {
			return errArtifactOverflow
		}
		v.SetUint(x)
	case reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Int:
		x, err := c.varint()
		if err != nil {
			return err
		}
		if v.OverflowInt(x) {
			return errArtifactOverflow
		}
		v.SetInt(x)
	case reflect.Float64:
		run, err := c.fixed(1, 8)
		if err != nil {
			return err
		}
		v.SetFloat(math.Float64frombits(binary.LittleEndian.Uint64(run)))
	default:
		return fmt.Errorf("unsupported bytecode field %s", v.Type())
	}
	return nil
}

// Back-references let a small artifact reach one subtree along many paths.
type artifactVerifier struct {
	functions map[*bytecode.Function]bool
	scopes    map[*bytecode.EvalScope]bool
	levels    map[*bytecode.EvalLevel]int
}

func verifyArtifact(fn *bytecode.Function) error {
	v := artifactVerifier{functions: make(map[*bytecode.Function]bool), scopes: make(map[*bytecode.EvalScope]bool), levels: make(map[*bytecode.EvalLevel]int)}
	return v.function(fn, 0)
}

func (v *artifactVerifier) function(fn *bytecode.Function, depth int) error {
	if fn == nil || depth > maxArtifactDepth {
		return fmt.Errorf("invalid bytecode function tree")
	}
	if v.functions[fn] {
		return nil
	}
	v.functions[fn] = true
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
			if v.scopes[scope] {
				continue
			}
			v.scopes[scope] = true
			levels, err := v.chain(scope.Env)
			if err != nil {
				return err
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
		if err := v.function(child, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func (v *artifactVerifier) chain(l *bytecode.EvalLevel) (int, error) {
	var walked []*bytecode.EvalLevel
	length := 0
	for ; l != nil; l = l.Outer {
		if known, ok := v.levels[l]; ok {
			length = known
			break
		}
		if len(walked) >= maxArtifactDepth || len(l.Names) != len(l.Kinds) || len(l.Names) != len(l.TDZ) {
			return 0, fmt.Errorf("invalid eval environment")
		}
		walked = append(walked, l)
	}
	for i := len(walked) - 1; i >= 0; i-- {
		length++
		v.levels[walked[i]] = length
	}
	if length > maxArtifactDepth {
		return 0, fmt.Errorf("invalid eval environment")
	}
	return length, nil
}

func encodeArtifact(fn *bytecode.Function) (string, error) {
	c := artifactCodec{data: []byte(artifactVersion), indexes: make(map[string]uint32), shared: make(map[sharedString]uint32), pointers: make(map[any]uint32)}
	if err := c.put(reflect.ValueOf(fn), 0); err != nil {
		return "", err
	}
	if len(c.data) > maxArtifactBytes {
		return "", errArtifactLimits
	}
	return base64.StdEncoding.EncodeToString(c.data), nil
}

func decodeArtifact(text string, kind bytecode.Kind) (*bytecode.Function, error) {
	if len(text) > base64.StdEncoding.EncodedLen(maxArtifactBytes) {
		return nil, errArtifactLimits
	}
	data, err := base64.StdEncoding.Strict().DecodeString(text)
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(data, []byte(artifactVersion)) {
		return nil, fmt.Errorf("unsupported bytecode artifact version")
	}
	c := artifactCodec{data: data, pos: len(artifactVersion)}
	var fn *bytecode.Function
	if err := c.get(reflect.ValueOf(&fn).Elem(), 0); err != nil {
		return nil, err
	}
	if c.remaining() != 0 {
		return nil, fmt.Errorf("trailing bytecode artifact data")
	}
	if err := verifyArtifact(fn); err != nil {
		return nil, err
	}
	if fn.Kind != kind || (kind == bytecode.KindModule && fn.Module == nil) {
		return nil, fmt.Errorf("incorrect bytecode artifact kind")
	}
	return fn, nil
}

var errNotHeld = wireError("bytecode sent by id is not held by this endpoint")

func (b *bridge) compilePrepared(p *payload) (*compiledModule, error) {
	if mod := b.modules[p.ModuleID]; mod != nil {
		return mod, nil
	}
	if p.Held {
		return nil, errNotHeld
	}
	var code *bytecode.Function
	var early func() (*bytecode.Function, error)
	var err error
	if p.Code != "" {
		code, err = decodeArtifact(p.Code, bytecode.KindModule)
		if err == nil {
			early, err = earlyArtifact(code, p.EarlyCode)
		}
	} else {
		if b.rt != nil {
			return nil, wireError("compiled module bytecode is required")
		}
		if err := b.compileExpired(); err != nil {
			return nil, err
		}
		var parsed *syntax.Module
		parsed, err = syntax.ParseModule(p.Name, p.Source, syntax.Options{TypeScript: p.TypeScript, Stop: b.stopCompile})
		if err == nil {
			code, err = compiler.CompileModuleStop(parsed, b.stopCompile)
		}
		if err == nil && !requestsModules(code) {
			// Upstream builds this variant lazily without the compile's stop function.
			parsed, err = syntax.ParseModule(p.Name, p.Source, syntax.Options{TypeScript: p.TypeScript, EarlyExports: true})
			var variant *bytecode.Function
			if err == nil {
				variant, err = compiler.CompileModule(parsed)
			}
			early = loaded(variant)
		}
	}
	if err != nil {
		return nil, err
	}
	mod := &compiledModule{code: code, name: code.Source.Name, exports: make([]string, len(code.Module.Exports)), requests: []string{}}
	mod.early = early
	for i, e := range code.Module.Exports {
		mod.exports[i] = e.Name
	}
	if code.Module.Links != nil {
		for _, r := range code.Module.Links.Requests {
			mod.requests = append(mod.requests, r.Specifier)
		}
	}
	b.modules[p.ModuleID] = mod
	b.held = append(b.held, p.ModuleID)
	b.registerModule(mod, p)
	return mod, nil
}

func (b *bridge) compileScriptPrepared(p *payload) (*bytecode.Function, error) {
	if code := b.scripts[p.ScriptID]; code != nil {
		return code, nil
	}
	if p.Held {
		return nil, errNotHeld
	}
	var code *bytecode.Function
	var err error
	if p.Code != "" {
		code, err = decodeArtifact(p.Code, bytecode.KindScript)
	} else {
		if b.rt != nil {
			return nil, wireError("compiled script bytecode is required")
		}
		if err := b.compileExpired(); err != nil {
			return nil, err
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
	if b.rt != nil {
		b.scripts[p.ScriptID] = code
		b.held = append(b.held, p.ScriptID)
	}
	return code, nil
}

// Only import-free modules have an early variant; one equal to the code crosses as "=".
const sameEarlyCode = "="

func requestsModules(code *bytecode.Function) bool {
	return code.Module.Links != nil && len(code.Module.Links.Requests) != 0
}

func loaded(code *bytecode.Function) func() (*bytecode.Function, error) {
	return func() (*bytecode.Function, error) { return code, nil }
}

func earlyArtifact(code *bytecode.Function, text string) (func() (*bytecode.Function, error), error) {
	switch {
	case text == sameEarlyCode:
		return loaded(code), nil
	case text == "" && requestsModules(code):
		return nil, nil
	case text == "":
		return nil, wireError("early exports bytecode is required")
	}
	return sync.OnceValues(func() (*bytecode.Function, error) {
		return decodeArtifact(text, bytecode.KindModule)
	}), nil
}

func moduleMetadata(mod *compiledModule, exports []string, artifacts bool) (map[string]any, error) {
	locations := make(map[string]any)
	if links := mod.code.Module.Links; links != nil {
		for _, req := range links.Requests {
			locations[req.Specifier] = map[string]any{"line": req.Line, "column": req.Col}
		}
	}
	metadata := map[string]any{"name": mod.name, "exports": exports, "requests": mod.requests, "requestLocations": locations, "links": mod.code.Module.Links != nil}
	if artifacts {
		code, err := encodeArtifact(mod.code)
		if err != nil {
			return nil, err
		}
		early := ""
		if mod.early != nil {
			variant, err := mod.early()
			if err != nil {
				return nil, err
			}
			if early, err = encodeArtifact(variant); err != nil {
				return nil, err
			}
			if early == code {
				early, mod.early = sameEarlyCode, loaded(mod.code)
			}
		}
		metadata["code"], metadata["earlyCode"] = base64Text(code), base64Text(early)
	}
	return metadata, nil
}

func scriptMetadata(code *bytecode.Function) (map[string]any, error) {
	data, err := encodeArtifact(code)
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": code.Source.Name, "code": base64Text(data), "referrer": code.ScriptOrModule}, nil
}
