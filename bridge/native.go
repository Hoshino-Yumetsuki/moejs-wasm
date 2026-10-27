//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/bytecode"
	"github.com/Calcium-Ion/moejs/compiler"
	"github.com/Calcium-Ion/moejs/engine"
)

type nativeState struct {
	natives           map[int]reflect.Value
	nextNativeID      int
	removeNativeRoots func()
}
type nativePayload struct {
	Native       wireValue       `json:"native"`
	NativeTarget wireValue       `json:"nativeTarget"`
	NativeRoot   string          `json:"nativeRoot"`
	NativeType   json.RawMessage `json:"nativeType"`
	Method       string          `json:"method"`
	Field        string          `json:"field"`
	NativeArgs   wireValue       `json:"nativeArgs"`
}

var nativeValueType = reflect.TypeOf(moejs.Undefined())
var nativeErrorType = reflect.TypeOf((*error)(nil)).Elem()
var nativeDescriptorType = reflect.TypeOf(engine.PropertyDescriptor{})

type nativeConversionKey struct {
	id     int
	target reflect.Type
}
type nativeConversion struct {
	b           *bridge
	values      map[nativeConversionKey]reflect.Value
	definitions map[int]wireValue
	guest       map[int]moejs.Value
}

func (b *bridge) nativeConversion(w wireValue) (*nativeConversion, wireValue, error) {
	w, err := b.expandWire(w)
	if err != nil {
		return nil, wireValue{}, err
	}
	c := &nativeConversion{b: b, values: make(map[nativeConversionKey]reflect.Value), definitions: make(map[int]wireValue), guest: make(map[int]moejs.Value)}
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case wireValue:
			if value.ID > 0 && value.T != "link" && value.T != "ref" && value.T != "native" && value.T != "function" && value.T != "symbol" {
				c.definitions[value.ID] = value
			}
			visit(value.V)
		case map[string]any:
			if item, e := readWire(value); e == nil {
				visit(item)
			}
		case []any:
			for _, item := range value {
				visit(item)
			}
		case []wireValue:
			for _, item := range value {
				visit(item)
			}
		}
	}
	visit(w)
	return c, w, nil
}
func (c *nativeConversion) decode(w wireValue) (moejs.Value, error) {
	if w.T == "link" {
		if value, ok := c.guest[w.ID]; ok {
			return value, nil
		}
		if definition, ok := c.definitions[w.ID]; ok {
			w = definition
		}
	}
	if definition, ok := c.definitions[w.ID]; ok && definition.T == w.T {
		if value, exists := c.guest[w.ID]; exists {
			return value, nil
		}
	}
	return c.b.decodeGraph(w, true, 0, c.guest)
}

func (b *bridge) nativeValue(id int) (reflect.Value, error) {
	v, ok := b.natives[id]
	if !ok || id <= 0 {
		return reflect.Value{}, wireError("unknown or released native handle")
	}
	return v, nil
}
func (b *bridge) releaseNatives() {
	if b.removeNativeRoots != nil {
		b.removeNativeRoots()
		b.removeNativeRoots = nil
	}
	clear(b.natives)
	b.natives = nil
}
func (b *bridge) encodeNative(v reflect.Value) (wireValue, error) {
	w, err := b.encodeNativeGraph(v, &nativeEncoding{seen: make(map[nativeSliceIdentity]int)})
	if err != nil {
		return wireValue{}, err
	}
	if w.T == "array" {
		return flattenWire(w), nil
	}
	return w, nil
}

type nativeSliceIdentity struct {
	target  reflect.Type
	pointer uintptr
	length  int
}
type nativeEncoding struct {
	seen   map[nativeSliceIdentity]int
	nextID int
}

func (b *bridge) encodeNativeGraph(v reflect.Value, state *nativeEncoding) (wireValue, error) {
	if !v.IsValid() {
		return wireValue{T: "null"}, nil
	}
	for v.Kind() == reflect.Interface {
		if v.IsNil() {
			return wireValue{T: "null"}, nil
		}
		v = v.Elem()
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Func, reflect.Map, reflect.Slice:
		if v.IsNil() {
			return wireValue{T: "null"}, nil
		}
	}
	switch v.Kind() {
	case reflect.Bool:
		return wireValue{T: "boolean", V: v.Bool()}, nil
	case reflect.String:
		return wireValue{T: "string", V: v.String()}, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n := v.Int()
		if n > 9007199254740991 || n < -9007199254740991 {
			return wireValue{T: "bigint", V: strconv.FormatInt(n, 10)}, nil
		}
		return wireValue{T: "number", V: float64(n)}, nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		n := v.Uint()
		if n > 9007199254740991 {
			return wireValue{T: "bigint", V: strconv.FormatUint(n, 10)}, nil
		}
		return wireValue{T: "number", V: float64(n)}, nil
	case reflect.Float32, reflect.Float64:
		n := v.Float()
		var x any = n
		if math.IsNaN(n) {
			x = "NaN"
		} else if math.IsInf(n, 1) {
			x = "Infinity"
		} else if math.IsInf(n, -1) {
			x = "-Infinity"
		} else if n == 0 && math.Signbit(n) {
			x = "-0"
		}
		return wireValue{T: "number", V: x}, nil
	case reflect.Array, reflect.Slice:
		if v.Kind() == reflect.Slice {
			key := nativeSliceIdentity{v.Type(), v.Pointer(), v.Len()}
			if old := state.seen[key]; old != 0 {
				return wireValue{T: "link", ID: old}, nil
			}
		}
		state.nextID++
		id := state.nextID
		if v.Kind() == reflect.Slice {
			state.seen[nativeSliceIdentity{v.Type(), v.Pointer(), v.Len()}] = id
		}
		out := make([]wireValue, v.Len())
		for i := range out {
			w, e := b.encodeNativeGraph(v.Index(i), state)
			if e != nil {
				return wireValue{}, e
			}
			out[i] = w
		}
		return wireValue{T: "array", ID: id, V: out}, nil
	}
	// Values may occupy reusable interpreter registers; retain a value copy, never their address.
	if v.Kind() == reflect.Struct {
		if v.CanAddr() && v.Type() != nativeValueType {
			v = v.Addr()
		} else {
			p := reflect.New(v.Type())
			p.Elem().Set(v)
			v = p
		}
	}
	if b.natives == nil {
		b.natives = make(map[int]reflect.Value)
		b.removeNativeRoots = b.rt.AddLiveRoots(func(add func(moejs.Value)) {
			seen := make(map[uintptr]bool)
			for _, value := range b.natives {
				b.nativeRoots(value, add, seen)
			}
		})
	}
	name := ""
	if referrer, ok := v.Interface().(moejs.Referrer); ok {
		name = referrer.Name()
	}
	// Pointer identity is stable; functions deliberately do not share code-pointer identities.
	if v.Kind() == reflect.Pointer {
		for id, old := range b.natives {
			if old.Type() == v.Type() && old.Kind() == reflect.Pointer && old.Pointer() == v.Pointer() {
				return wireValue{T: "native", ID: id, Kind: v.Type().String(), Name: name}, nil
			}
		}
	}
	b.nextNativeID++
	b.natives[b.nextNativeID] = v
	return wireValue{T: "native", ID: b.nextNativeID, Kind: v.Type().String(), Name: name}, nil
}
func (b *bridge) nativeDecodeTarget(w wireValue) (any, error) {
	if w.T != "native" {
		return nil, wireError("decode target must be a native pointer")
	}
	v, e := b.nativeValue(w.ID)
	if e != nil {
		return nil, e
	}
	if v.Kind() != reflect.Pointer || v.IsNil() {
		return nil, wireError("decode target must be a non-nil native pointer")
	}
	return v.Interface(), nil
}
func nativeWireChildren(w wireValue) ([]wireValue, error) {
	items, ok := w.V.([]any)
	if !ok {
		if direct, yes := w.V.([]wireValue); yes {
			return direct, nil
		}
		return nil, wireError("expected native array")
	}
	out := make([]wireValue, len(items))
	for i, x := range items {
		v, e := readWire(x)
		if e != nil {
			return nil, e
		}
		out[i] = v
	}
	return out, nil
}
func nativeWireFields(w wireValue) (map[string]wireValue, error) {
	if w.T != "object" && w.T != "map" {
		return nil, wireError("expected native field object")
	}
	items, ok := w.V.([]any)
	if !ok {
		return nil, wireError("invalid native field object")
	}
	out := make(map[string]wireValue, len(items))
	for _, item := range items {
		pair, ok := item.([]any)
		if !ok || len(pair) != 2 {
			return nil, wireError("invalid native field entry")
		}
		key, ok := pair[0].(string)
		if !ok {
			kw, e := readWire(pair[0])
			if e != nil || kw.T != "string" {
				return nil, wireError("native field name must be a string")
			}
			key, _ = kw.V.(string)
		}
		value, e := readWire(pair[1])
		if e != nil {
			return nil, e
		}
		out[key] = value
	}
	return out, nil
}
func nativeIndirect(v reflect.Value) reflect.Value {
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return reflect.Value{}
		}
		v = v.Elem()
	}
	return v
}

func (b *bridge) convertNative(w wireValue, t reflect.Type) (reflect.Value, error) {
	c, expanded, e := b.nativeConversion(w)
	if e != nil {
		return reflect.Value{}, e
	}
	return c.convert(expanded, t, 0)
}
func (c *nativeConversion) convert(w wireValue, t reflect.Type, depth int) (reflect.Value, error) {
	b := c.b
	if w.T == "link" {
		if value, ok := c.values[nativeConversionKey{w.ID, t}]; ok {
			return value, nil
		}
		for key, value := range c.values {
			if key.id == w.ID && value.Type().AssignableTo(t) {
				return value, nil
			}
		}
		definition, ok := c.definitions[w.ID]
		if !ok {
			return reflect.Value{}, wireError("invalid native graph reference")
		}
		w = definition
	}
	key := nativeConversionKey{w.ID, t}
	definition, graphNode := c.definitions[w.ID]
	graphNode = graphNode && definition.T == w.T
	if graphNode {
		if value, ok := c.values[key]; ok {
			return value, nil
		}
	}
	remember := func(value reflect.Value) reflect.Value {
		if graphNode {
			c.values[key] = value
		}
		return value
	}
	fail := func(message string) (reflect.Value, error) {
		return reflect.Value{}, wireError("native " + t.String() + ": " + message)
	}
	if depth > 10000 {
		return fail("conversion nesting exceeds 10000")
	}
	if w.T == "native" {
		v, e := b.nativeValue(w.ID)
		if e != nil {
			return reflect.Value{}, e
		}
		if v.Kind() == reflect.Pointer && !v.IsNil() && v.Elem().Type() == nativeValueType && v.Elem().Type().AssignableTo(t) {
			return v.Elem(), nil
		}
		if v.Type().AssignableTo(t) {
			return v, nil
		}
		if v.Kind() == reflect.Pointer && !v.IsNil() && v.Elem().Type().AssignableTo(t) {
			return v.Elem(), nil
		}
		if t == nativeValueType {
			gv, e := b.nativeAsValue(v)
			return reflect.ValueOf(gv), e
		}
		if gv, e := b.nativeAsValue(v); e == nil {
			return c.convert(b.retainValue(gv), t, depth+1)
		}
		return fail("handle has type " + v.Type().String())
	}
	if w.T == "null" || w.T == "undefined" || w.T == "" {
		switch t.Kind() {
		case reflect.Pointer, reflect.Interface, reflect.Slice, reflect.Map, reflect.Func:
			return reflect.Zero(t), nil
		}
		if t == nativeValueType {
			v, e := c.decode(w)
			return reflect.ValueOf(v), e
		}
		return fail("nil is not assignable")
	}
	if t == nativeValueType {
		v, e := c.decode(w)
		return reflect.ValueOf(v), e
	}
	if t == reflect.TypeOf((*big.Int)(nil)) && w.T == "bigint" {
		text, _ := w.V.(string)
		value, ok := new(big.Int).SetString(text, 10)
		if !ok {
			return fail("invalid bigint")
		}
		return reflect.ValueOf(value), nil
	}
	if t == reflect.TypeOf((*engine.Object)(nil)) || t == reflect.TypeOf((*engine.String)(nil)) || t == reflect.TypeOf((*engine.Symbol)(nil)) || t == reflect.TypeOf((*engine.BigInt)(nil)) {
		v, e := c.decode(w)
		if e != nil {
			return reflect.Value{}, e
		}
		switch {
		case t == reflect.TypeOf((*engine.Object)(nil)) && v.IsObject():
			return reflect.ValueOf(v.AsObject()), nil
		case t == reflect.TypeOf((*engine.String)(nil)) && v.IsString():
			return reflect.ValueOf(v.AsString()), nil
		case t == reflect.TypeOf((*engine.Symbol)(nil)) && v.Type() == engine.TypeSymbol:
			return reflect.ValueOf(v.AsSymbol()), nil
		case t == reflect.TypeOf((*engine.BigInt)(nil)) && v.Type() == engine.TypeBigInt:
			return reflect.ValueOf(v.AsBigInt()), nil
		}
		return fail("incompatible guest value")
	}
	if t == reflect.TypeOf(engine.PropertyKey{}) {
		v, e := c.decode(w)
		if e != nil {
			return reflect.Value{}, e
		}
		k, e := b.rt.Realm().ToPropertyKey(v)
		return reflect.ValueOf(k), e
	}
	if t == nativeDescriptorType {
		return c.nativeDescriptor(w, depth)
	}
	if t.Kind() == reflect.Slice && t.Elem().Kind() == reflect.Uint8 && (w.T == "view" || w.T == "buffer" || w.T == "ref") {
		value, e := c.decode(w)
		if e != nil {
			return reflect.Value{}, e
		}
		if !value.IsObject() {
			return fail("expected a byte buffer or view")
		}
		bytes, ok := value.AsObject().BufferData()
		if !ok {
			return fail("expected a byte buffer or view")
		}
		out := reflect.MakeSlice(t, len(bytes), len(bytes))
		for i, byteValue := range bytes {
			out.Index(i).SetUint(uint64(byteValue))
		}
		return out, nil
	}
	if t == reflect.TypeOf(time.Time{}) && w.T == "date" {
		gv, e := c.decode(w)
		if e != nil {
			return reflect.Value{}, e
		}
		x, e := b.rt.ToGo(gv)
		if e != nil {
			return reflect.Value{}, e
		}
		v := reflect.ValueOf(x)
		if v.IsValid() && v.Type() == t {
			return v, nil
		}
		return fail("invalid date")
	}
	if t == nativeErrorType && w.T == "error" {
		v, e := c.decode(w)
		if e != nil {
			return reflect.Value{}, e
		}
		return reflect.ValueOf(b.rt.Realm().Throw(v)), nil
	}
	if t.Kind() == reflect.Func && w.T == "function" {
		if w.ID <= 0 {
			return fail("invalid host callback")
		}
		return b.nativeCallback(w.ID, t), nil
	}
	if t.Kind() == reflect.Interface {
		if t == reflect.TypeOf((*engine.Compiler)(nil)).Elem() {
			fields, e := nativeWireFields(w)
			if e != nil {
				return reflect.Value{}, e
			}
			adapter := &nativeCompiler{}
			for _, entry := range []struct {
				name   string
				target any
			}{{"compileScript", &adapter.script}, {"compileEval", &adapter.eval}, {"compileFunction", &adapter.function}} {
				item, ok := fields[entry.name]
				if !ok {
					return fail("compiler requires " + entry.name)
				}
				slot := reflect.ValueOf(entry.target).Elem()
				fn, e := c.convert(item, slot.Type(), depth+1)
				if e != nil {
					return reflect.Value{}, e
				}
				slot.Set(fn)
			}
			return reflect.ValueOf(adapter), nil
		}
		if w.T == "object" {
			fields, e := nativeWireFields(w)
			if e != nil {
				return reflect.Value{}, e
			}
			report, ok := fields["reportLive"]
			callable := ok && report.T == "function"
			if ok && report.T == "native" {
				value, exists := b.natives[report.ID]
				callable = exists && value.Kind() == reflect.Func
			}
			if callable {
				ft := reflect.TypeOf((func(func(moejs.Value), func(int)))(nil))
				fn, e := c.convert(report, ft, depth+1)
				if e != nil {
					return reflect.Value{}, e
				}
				reporter := reflect.ValueOf(&nativeLiveReporter{fn: fn.Interface().(func(func(moejs.Value), func(int)))})
				if reporter.Type().AssignableTo(t) {
					return reporter, nil
				}
			}
		}
		if t.NumMethod() != 0 {
			return fail("interface requires a compatible native handle")
		}
		switch w.T {
		case "array":
			items, e := nativeWireChildren(w)
			if e != nil {
				return reflect.Value{}, e
			}
			out := make([]any, len(items))
			remember(reflect.ValueOf(out))
			for i, item := range items {
				v, e := c.convert(item, t, depth+1)
				if e != nil {
					return reflect.Value{}, e
				}
				if v.IsValid() {
					out[i] = v.Interface()
				}
			}
			return reflect.ValueOf(out), nil
		case "object":
			fields, e := nativeWireFields(w)
			if e != nil {
				return reflect.Value{}, e
			}
			out := make(map[string]any, len(fields))
			remember(reflect.ValueOf(out))
			for key, item := range fields {
				v, e := c.convert(item, t, depth+1)
				if e != nil {
					return reflect.Value{}, e
				}
				if v.IsValid() {
					out[key] = v.Interface()
				}
			}
			return reflect.ValueOf(out), nil
		case "bigint":
			s, _ := w.V.(string)
			n, ok := new(big.Int).SetString(s, 10)
			if !ok {
				return fail("invalid bigint")
			}
			return reflect.ValueOf(n), nil
		}
		gv, e := c.decode(w)
		if e != nil {
			return reflect.Value{}, e
		}
		x, e := b.rt.ToGo(gv)
		if e != nil {
			return reflect.Value{}, e
		}
		if x == nil {
			return reflect.Zero(t), nil
		}
		return reflect.ValueOf(x), nil
	}
	out := reflect.New(t).Elem()
	switch t.Kind() {
	case reflect.Pointer:
		out.Set(reflect.New(t.Elem()))
		remember(out)
		v, e := c.convert(w, t.Elem(), depth+1)
		if e != nil {
			return reflect.Value{}, e
		}
		out.Elem().Set(v)
		return out, nil
	case reflect.Bool:
		if w.T == "boolean" {
			v, ok := w.V.(bool)
			if ok {
				out.SetBool(v)
				return out, nil
			}
		}
	case reflect.String:
		if w.T == "string" {
			s, ok := w.V.(string)
			if ok {
				out.SetString(s)
				return out, nil
			}
		}
		if w.T == "string16" {
			value, e := c.decode(w)
			if e != nil {
				return reflect.Value{}, e
			}
			out.SetString(value.AsString().GoString())
			return out, nil
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		n := new(big.Int)
		switch w.T {
		case "bigint":
			s, _ := w.V.(string)
			if _, ok := n.SetString(s, 10); !ok {
				return fail("invalid integer")
			}
		case "number":
			f, ok := w.V.(float64)
			if !ok || math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f || math.Abs(f) > 9007199254740991 {
				return fail("expected exact safe integer or bigint")
			}
			n.SetInt64(int64(f))
		default:
			return fail("expected integer")
		}
		if t.Kind() >= reflect.Uint && t.Kind() <= reflect.Uintptr {
			if n.Sign() < 0 || !n.IsUint64() || out.OverflowUint(n.Uint64()) {
				return fail("integer overflows target")
			}
			out.SetUint(n.Uint64())
		} else {
			if !n.IsInt64() || out.OverflowInt(n.Int64()) {
				return fail("integer overflows target")
			}
			out.SetInt(n.Int64())
		}
		return out, nil
	case reflect.Float32, reflect.Float64:
		if w.T == "number" {
			v, e := b.decode(w, true, 0)
			if e != nil {
				return reflect.Value{}, e
			}
			n := v.AsNumber()
			if out.OverflowFloat(n) {
				return fail("number overflows target")
			}
			out.SetFloat(n)
			return out, nil
		}
	case reflect.Slice, reflect.Array:
		if w.T == "buffer" {
			w.T = "array"
			items, ok := w.V.([]any)
			if !ok {
				return fail("invalid byte buffer")
			}
			converted := make([]wireValue, len(items))
			for i, x := range items {
				converted[i] = wireValue{T: "number", V: x}
			}
			w.V = converted
		}
		if w.T != "array" {
			return fail("expected array")
		}
		items, e := nativeWireChildren(w)
		if e != nil {
			return reflect.Value{}, e
		}
		if t.Kind() == reflect.Array && len(items) != t.Len() {
			return fail("array length mismatch")
		}
		if t.Kind() == reflect.Slice {
			out = reflect.MakeSlice(t, len(items), len(items))
		}
		remember(out)
		for i, item := range items {
			v, e := c.convert(item, t.Elem(), depth+1)
			if e != nil {
				return reflect.Value{}, fmt.Errorf("index %d: %w", i, e)
			}
			out.Index(i).Set(v)
		}
		return out, nil
	case reflect.Struct:
		fields, e := nativeWireFields(w)
		if e != nil {
			return reflect.Value{}, e
		}
		for name, item := range fields {
			f, ok := t.FieldByName(name)
			if !ok {
				for i := range t.NumField() {
					candidate := t.Field(i)
					tag := strings.Split(candidate.Tag.Get("json"), ",")[0]
					if tag == name && tag != "-" {
						f = candidate
						ok = true
						break
					}
				}
			}
			if !ok || f.PkgPath != "" {
				return fail("unknown or unexported field " + name)
			}
			v, e := c.convert(item, f.Type, depth+1)
			if e != nil {
				return reflect.Value{}, fmt.Errorf("field %s: %w", name, e)
			}
			out.FieldByIndex(f.Index).Set(v)
		}
		return out, nil
	case reflect.Map:
		out = reflect.MakeMap(t)
		remember(out)
		if w.T == "object" {
			fields, e := nativeWireFields(w)
			if e != nil {
				return reflect.Value{}, e
			}
			for name, item := range fields {
				keyWire := wireValue{T: "string", V: name}
				if t.Key().Kind() >= reflect.Int && t.Key().Kind() <= reflect.Uintptr {
					keyWire = wireValue{T: "bigint", V: name}
				}
				k, e := c.convert(keyWire, t.Key(), depth+1)
				if e != nil {
					return reflect.Value{}, e
				}
				v, e := c.convert(item, t.Elem(), depth+1)
				if e != nil {
					return reflect.Value{}, e
				}
				out.SetMapIndex(k, v)
			}
			return out, nil
		}
		if w.T == "map" {
			items, ok := w.V.([]any)
			if !ok {
				return fail("invalid map")
			}
			for _, item := range items {
				pair, ok := item.([]any)
				if !ok || len(pair) != 2 {
					return fail("invalid map entry")
				}
				kw, e := readWire(pair[0])
				if e != nil {
					return reflect.Value{}, e
				}
				vw, e := readWire(pair[1])
				if e != nil {
					return reflect.Value{}, e
				}
				k, e := c.convert(kw, t.Key(), depth+1)
				if e != nil {
					return reflect.Value{}, e
				}
				v, e := c.convert(vw, t.Elem(), depth+1)
				if e != nil {
					return reflect.Value{}, e
				}
				out.SetMapIndex(k, v)
			}
			return out, nil
		}
	}
	return fail("incompatible wire type " + w.T)
}

type nativeLiveReporter struct {
	fn func(func(moejs.Value), func(int))
}

func (r *nativeLiveReporter) ReportLive(add func(moejs.Value), bytes func(int)) { r.fn(add, bytes) }

type nativeCompiler struct {
	script   func(string, string, func() error) (*bytecode.Function, error)
	eval     func(string, string, *bytecode.EvalScope, func() error) (*bytecode.Function, error)
	function func(string, string, string, bool, bool, func() error) (*bytecode.Function, error)
}

func (c *nativeCompiler) CompileScript(name, src string, stop func() error) (*bytecode.Function, error) {
	return c.script(name, src, stop)
}
func (c *nativeCompiler) CompileEval(name, src string, scope *bytecode.EvalScope, stop func() error) (*bytecode.Function, error) {
	return c.eval(name, src, scope, stop)
}
func (c *nativeCompiler) CompileFunction(name, params, body string, generator, async bool, stop func() error) (*bytecode.Function, error) {
	return c.function(name, params, body, generator, async, stop)
}
func (c *nativeConversion) nativeDescriptor(w wireValue, depth int) (reflect.Value, error) {
	b := c.b
	fields, e := nativeWireFields(w)
	if e != nil {
		return reflect.Value{}, e
	}
	d := engine.PropertyDescriptor{}
	for name, item := range fields {
		switch strings.ToLower(name) {
		case "value", "get", "set":
			v, e := c.convert(item, nativeValueType, depth+1)
			if e != nil {
				return reflect.Value{}, e
			}
			value := v.Interface().(moejs.Value)
			switch strings.ToLower(name) {
			case "value":
				d.SetValue(value)
			case "get":
				if e = b.rt.Realm().CheckAccessorFunction(value, false); e != nil {
					return reflect.Value{}, e
				}
				d.SetGet(value)
			case "set":
				if e = b.rt.Realm().CheckAccessorFunction(value, true); e != nil {
					return reflect.Value{}, e
				}
				d.SetSet(value)
			}
		case "writable", "enumerable", "configurable":
			v, e := c.convert(item, reflect.TypeOf(false), depth+1)
			if e != nil {
				return reflect.Value{}, e
			}
			switch strings.ToLower(name) {
			case "writable":
				d.SetWritable(v.Bool())
			case "enumerable":
				d.SetEnumerable(v.Bool())
			case "configurable":
				d.SetConfigurable(v.Bool())
			}
		default:
			return reflect.Value{}, wireError("unknown descriptor field " + name)
		}
	}
	if d.IsAccessorDescriptor() && d.IsDataDescriptor() {
		return reflect.Value{}, wireError("descriptor cannot contain both data and accessor fields")
	}
	return reflect.ValueOf(d), nil
}
func (b *bridge) nativeAsValue(v reflect.Value) (moejs.Value, error) {
	if !v.IsValid() {
		return moejs.Null(), nil
	}
	for v.Kind() == reflect.Interface {
		v = v.Elem()
	}
	if v.Kind() == reflect.Pointer && v.IsNil() {
		return moejs.Null(), nil
	}
	switch x := v.Interface().(type) {
	case moejs.Value:
		return x, nil
	case *engine.Object:
		return engine.ObjectValue(x), nil
	case *engine.String:
		return engine.StringValue(x), nil
	case *engine.Symbol:
		return engine.SymbolValue(x), nil
	case *engine.BigInt:
		return engine.BigIntValue(x), nil
	}
	if v.Kind() == reflect.Pointer && v.Elem().Type() == nativeValueType {
		return v.Elem().Interface().(moejs.Value), nil
	}
	return moejs.Undefined(), wireError("native handle is not an engine Value/Object/String/Symbol/BigInt")
}
func (b *bridge) nativeCallback(id int, t reflect.Type) reflect.Value {
	return reflect.MakeFunc(t, func(args []reflect.Value) []reflect.Value {
		out := make([]reflect.Value, t.NumOut())
		for i := range out {
			out[i] = reflect.Zero(t.Out(i))
		}
		encoded := make([]wireValue, len(args))
		var err error
		ephemeral := make([]int, 0)
		defer func() {
			for _, id := range ephemeral {
				delete(b.natives, id)
			}
		}()
		for i, arg := range args {
			encoded[i], err = b.encodeNative(arg)
			if err != nil {
				break
			}
			if arg.Kind() == reflect.Func && encoded[i].T == "native" {
				ephemeral = append(ephemeral, encoded[i].ID)
				encoded[i].Temporary = true
			}
		}
		var result wireValue
		if err == nil {
			result, err = b.callHost(id, encoded, wireValue{T: "undefined"})
		}
		count := len(out)
		hasError := count > 0 && t.Out(count-1) == nativeErrorType
		if hasError {
			count--
		}
		if err == nil && count > 0 {
			conversion, expanded, e := b.nativeConversion(result)
			err = e
			if err == nil {
				results := []wireValue{expanded}
				if count > 1 {
					results, err = nativeWireChildren(expanded)
					if err == nil && len(results) != count {
						err = wireError("callback returned wrong number of results")
					}
				}
				if err == nil {
					for i := range count {
						out[i], err = conversion.convert(results[i], t.Out(i), 0)
						if err != nil {
							break
						}
					}
				}
			}
		}
		if err != nil {
			if hasError {
				for i := range count {
					out[i] = reflect.Zero(t.Out(i))
				}
				out[len(out)-1] = reflect.ValueOf(err)
			} else {
				panic(err)
			}
		}
		return out
	})
}
func (b *bridge) nativeInvoke(fn reflect.Value, arguments wireValue) (wireValue, error) {
	if !fn.IsValid() || fn.Kind() != reflect.Func || fn.IsNil() {
		return wireValue{}, wireError("native member is not callable")
	}
	conversion, expanded, err := b.nativeConversion(arguments)
	if err != nil {
		return wireValue{}, err
	}
	args, err := nativeWireChildren(expanded)
	if err != nil {
		return wireValue{}, err
	}
	t := fn.Type()
	minimum := t.NumIn()
	if t.IsVariadic() {
		minimum--
	}
	if len(args) < minimum || (!t.IsVariadic() && len(args) != minimum) {
		return wireValue{}, wireError(fmt.Sprintf("native call expects %d arguments (variadic=%t), received %d", minimum, t.IsVariadic(), len(args)))
	}
	in := make([]reflect.Value, len(args))
	for i, w := range args {
		var target reflect.Type
		if t.IsVariadic() && i >= minimum {
			target = t.In(t.NumIn() - 1).Elem()
		} else {
			target = t.In(i)
		}
		v, e := conversion.convert(w, target, 0)
		if e != nil {
			return wireValue{}, fmt.Errorf("argument %d: %w", i, e)
		}
		in[i] = v
	}
	out := fn.Call(in)
	if len(out) > 0 && t.Out(t.NumOut()-1) == nativeErrorType {
		last := out[len(out)-1]
		out = out[:len(out)-1]
		if !last.IsNil() {
			return wireValue{}, last.Interface().(error)
		}
	}
	if len(out) == 0 {
		return wireValue{T: "undefined"}, nil
	}
	if len(out) == 1 {
		return b.encodeNative(out[0])
	}
	results := make([]wireValue, len(out))
	state := &nativeEncoding{seen: make(map[nativeSliceIdentity]int)}
	for i, v := range out {
		w, e := b.encodeNativeGraph(v, state)
		if e != nil {
			return wireValue{}, e
		}
		results[i] = w
	}
	return flattenWire(wireValue{T: "array", ID: state.nextID + 1, V: results}), nil
}

type nativeJSONCodec struct {
	Decode func(string) (any, error) `json:"-"`
	Encode func(any) (string, error) `json:"-"`
	Value  any                       `json:"-"`
}

func (c *nativeJSONCodec) UnmarshalJSON(data []byte) error {
	if c.Decode == nil {
		return wireError("JSONCodec requires Decode")
	}
	value, e := c.Decode(string(data))
	if e == nil {
		c.Value = value
	}
	return e
}
func (c nativeJSONCodec) MarshalJSON() ([]byte, error) {
	if c.Encode == nil {
		return json.Marshal(c.Value)
	}
	text, e := c.Encode(c.Value)
	if e != nil {
		return nil, e
	}
	if !json.Valid([]byte(text)) {
		return nil, wireError("JSONCodec Encode returned invalid JSON")
	}
	return []byte(text), nil
}

type nativeTextCodec struct {
	Decode func(string) (any, error) `json:"-"`
	Encode func(any) (string, error) `json:"-"`
	Value  any                       `json:"-"`
}

func (c *nativeTextCodec) UnmarshalText(data []byte) error {
	if c.Decode == nil {
		return wireError("TextCodec requires Decode")
	}
	value, e := c.Decode(string(data))
	if e == nil {
		c.Value = value
	}
	return e
}
func (c nativeTextCodec) MarshalText() ([]byte, error) {
	if c.Encode == nil {
		return nil, wireError("TextCodec requires Encode")
	}
	text, e := c.Encode(c.Value)
	return []byte(text), e
}
func nativeNamedTypes() map[string]reflect.Type {
	types := map[string]reflect.Type{
		"any": reflect.TypeOf((*any)(nil)).Elem(), "bool": reflect.TypeOf(false), "string": reflect.TypeOf(""), "int": reflect.TypeOf(int(0)), "int8": reflect.TypeOf(int8(0)), "int16": reflect.TypeOf(int16(0)), "int32": reflect.TypeOf(int32(0)), "int64": reflect.TypeOf(int64(0)), "uint": reflect.TypeOf(uint(0)), "uint8": reflect.TypeOf(uint8(0)), "uint16": reflect.TypeOf(uint16(0)), "uint32": reflect.TypeOf(uint32(0)), "uint64": reflect.TypeOf(uint64(0)), "float32": reflect.TypeOf(float32(0)), "float64": reflect.TypeOf(float64(0)), "Value": nativeValueType, "Object": reflect.TypeOf(engine.Object{}), "String": reflect.TypeOf(engine.String{}), "Symbol": reflect.TypeOf(engine.Symbol{}), "BigInt": reflect.TypeOf(engine.BigInt{}), "PropertyKey": reflect.TypeOf(engine.PropertyKey{}), "PropertyDescriptor": nativeDescriptorType, "DecodeOptions": reflect.TypeOf(moejs.DecodeOptions{}), "JSONOptions": reflect.TypeOf(moejs.JSONOptions{}), "time.Time": reflect.TypeOf(time.Time{}), "time.Location": reflect.TypeOf(time.Location{}), "json.RawMessage": reflect.TypeOf(json.RawMessage{}),
	}
	types["JSONCodec"] = reflect.TypeOf(nativeJSONCodec{})
	types["TextCodec"] = reflect.TypeOf(nativeTextCodec{})
	for name, t := range nativeRegistryTypes_engine() {
		types[name] = t
	}
	for name, t := range nativeRegistryTypes_moejs() {
		types[name] = t
	}
	return types
}
func nativeSchemaType(raw json.RawMessage, depth int) (reflect.Type, error) {
	if depth > 100 {
		return nil, wireError("native schema nesting exceeds 100")
	}
	var name string
	if json.Unmarshal(raw, &name) == nil {
		if t, ok := nativeNamedTypes()[name]; ok {
			return t, nil
		}
		return nil, wireError("unknown native type " + name)
	}
	var schema struct {
		Kind    string          `json:"kind"`
		Element json.RawMessage `json:"element"`
		Key     json.RawMessage `json:"key"`
		Value   json.RawMessage `json:"value"`
		Length  int             `json:"length"`
		Fields  []struct {
			Name string          `json:"name"`
			Type json.RawMessage `json:"type"`
			Tag  string          `json:"tag"`
		} `json:"fields"`
	}
	if e := json.Unmarshal(raw, &schema); e != nil {
		return nil, e
	}
	switch schema.Kind {
	case "pointer", "slice", "array":
		t, e := nativeSchemaType(schema.Element, depth+1)
		if e != nil {
			return nil, e
		}
		switch schema.Kind {
		case "pointer":
			return reflect.PointerTo(t), nil
		case "slice":
			return reflect.SliceOf(t), nil
		default:
			if schema.Length < 0 || schema.Length > 1000000 {
				return nil, wireError("invalid native array length")
			}
			return reflect.ArrayOf(schema.Length, t), nil
		}
	case "map":
		k, e := nativeSchemaType(schema.Key, depth+1)
		if e != nil {
			return nil, e
		}
		if !k.Comparable() {
			return nil, wireError("native map key must be comparable")
		}
		v, e := nativeSchemaType(schema.Value, depth+1)
		if e != nil {
			return nil, e
		}
		return reflect.MapOf(k, v), nil
	case "struct":
		fields := make([]reflect.StructField, len(schema.Fields))
		seen := make(map[string]bool)
		for i, f := range schema.Fields {
			runes := []rune(f.Name)
			if len(runes) == 0 || !unicode.IsUpper(runes[0]) || seen[f.Name] {
				return nil, wireError("native struct field must have a unique exported name")
			}
			for _, r := range runes {
				if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
					return nil, wireError("invalid native struct field name")
				}
			}
			seen[f.Name] = true
			t, e := nativeSchemaType(f.Type, depth+1)
			if e != nil {
				return nil, e
			}
			fields[i] = reflect.StructField{Name: f.Name, Type: t, Tag: reflect.StructTag(f.Tag)}
		}
		return reflect.StructOf(fields), nil
	}
	return nil, wireError("invalid native type schema")
}
func (b *bridge) nativeRoots(v reflect.Value, add func(moejs.Value), seen map[uintptr]bool) {
	if !v.IsValid() || !v.CanInterface() {
		return
	}
	if v.Kind() == reflect.Interface {
		if !v.IsNil() {
			b.nativeRoots(v.Elem(), add, seen)
		}
		return
	}
	if v.Type() == reflect.TypeOf(b.rt) || v.Type() == reflect.TypeOf(b.rt.Realm()) {
		return
	}
	if value, e := b.nativeAsValue(v); e == nil {
		add(value)
		return
	}
	if key, ok := v.Interface().(engine.PropertyKey); ok {
		add(key.Value())
		return
	}
	if key, ok := v.Interface().(*engine.PropertyKey); ok && key != nil {
		add(key.Value())
		return
	}
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() || seen[v.Pointer()] {
			return
		}
		seen[v.Pointer()] = true
		switch value := v.Interface().(type) {
		case *engine.Env:
			for _, slot := range value.Slots() {
				add(slot)
			}
			b.nativeRoots(reflect.ValueOf(value.Parent()), add, seen)
		case *engine.FunctionData:
			b.nativeRoots(reflect.ValueOf(value.Env()), add, seen)
			add(value.ThisValue())
			if home := value.HomeObject(); home != nil {
				add(engine.ObjectValue(home))
			}
			b.nativeRoots(reflect.ValueOf(value.Data()), add, seen)
		default:
			b.nativeRoots(v.Elem(), add, seen)
		}
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Type().Field(i).PkgPath == "" {
				b.nativeRoots(v.Field(i), add, seen)
			}
		}
	case reflect.Slice, reflect.Array:
		if v.Kind() == reflect.Slice {
			if v.IsNil() || seen[v.Pointer()] {
				return
			}
			seen[v.Pointer()] = true
		}
		for i := range v.Len() {
			b.nativeRoots(v.Index(i), add, seen)
		}
	case reflect.Map:
		if v.IsNil() {
			return
		}
		pointer := uintptr(v.UnsafePointer())
		if seen[pointer] {
			return
		}
		seen[pointer] = true
		iter := v.MapRange()
		for iter.Next() {
			b.nativeRoots(iter.Key(), add, seen)
			b.nativeRoots(iter.Value(), add, seen)
		}
	}
}
func (b *bridge) nativeSnapshot(v reflect.Value, seen map[uintptr]bool, depth int) (wireValue, error) {
	if depth > 10000 {
		return wireValue{}, wireError("native snapshot nesting exceeds 10000")
	}
	if !v.IsValid() {
		return wireValue{T: "null"}, nil
	}
	if v.Kind() == reflect.Interface {
		if v.IsNil() {
			return wireValue{T: "null"}, nil
		}
		return b.nativeSnapshot(v.Elem(), seen, depth+1)
	}
	if value, e := b.nativeAsValue(v); e == nil {
		if depth == 0 {
			return b.encode(value, nil, 0)
		}
		if value.IsObject() || value.Type() == engine.TypeSymbol {
			return b.retainValue(value), nil
		}
		encoded, e := b.encode(value, nil, 0)
		if e != nil {
			return wireValue{}, e
		}
		return b.expandWire(encoded)
	}
	if v.Type() == reflect.TypeOf(time.Time{}) {
		return wireValue{T: "date", V: wireValue{T: "number", V: float64(v.Interface().(time.Time).UnixMilli())}}, nil
	}
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return wireValue{T: "null"}, nil
		}
		p := v.Pointer()
		if seen[p] {
			return b.encodeNative(v)
		}
		seen[p] = true
		defer delete(seen, p)
		return b.nativeSnapshot(v.Elem(), seen, depth+1)
	}
	switch v.Kind() {
	case reflect.Struct:
		fields := make([]any, 0, v.NumField())
		for i := range v.NumField() {
			f := v.Type().Field(i)
			if f.PkgPath != "" {
				continue
			}
			w, e := b.nativeSnapshot(v.Field(i), seen, depth+1)
			if e != nil {
				return wireValue{}, e
			}
			fields = append(fields, []any{f.Name, w})
		}
		return wireValue{T: "object", V: fields}, nil
	case reflect.Slice, reflect.Array:
		if v.Kind() == reflect.Slice && v.IsNil() {
			return wireValue{T: "null"}, nil
		}
		if v.Kind() == reflect.Slice {
			p := v.Pointer()
			if seen[p] {
				return b.encodeNative(v)
			}
			seen[p] = true
			defer delete(seen, p)
		}
		items := make([]wireValue, v.Len())
		for i := range items {
			w, e := b.nativeSnapshot(v.Index(i), seen, depth+1)
			if e != nil {
				return wireValue{}, e
			}
			items[i] = w
		}
		return wireValue{T: "array", V: items}, nil
	case reflect.Map:
		if v.IsNil() {
			return wireValue{T: "null"}, nil
		}
		p := uintptr(v.UnsafePointer())
		if seen[p] {
			return b.encodeNative(v)
		}
		seen[p] = true
		defer delete(seen, p)
		entries := make([]any, 0, v.Len())
		iter := v.MapRange()
		stringKeys := v.Type().Key().Kind() == reflect.String
		for iter.Next() {
			key, e := b.nativeSnapshot(iter.Key(), seen, depth+1)
			if e != nil {
				return wireValue{}, e
			}
			value, e := b.nativeSnapshot(iter.Value(), seen, depth+1)
			if e != nil {
				return wireValue{}, e
			}
			if stringKeys {
				entries = append(entries, []any{iter.Key().String(), value})
			} else {
				entries = append(entries, []any{key, value})
			}
		}
		tag := "map"
		if stringKeys {
			tag = "object"
		}
		return wireValue{T: tag, V: entries}, nil
	}
	return b.encodeNative(v)
}
func nativePackageFunctions(namespace string) map[string]any {
	var values map[string]any
	if namespace == "moejs" {
		values = nativeRegistry_moejs()
	} else {
		values = nativeRegistry_engine()
		values["Compiler"] = compiler.Hook{}
	}
	values["LoadLocation"] = time.LoadLocation
	values["UnixMilli"] = time.UnixMilli
	return values
}
func (b *bridge) dispatchNative(op string, p payload) (result operationResult, handled bool, err error) {
	if !strings.HasPrefix(op, "native") {
		return operationResult{}, false, nil
	}
	handled = true
	// Engine escape-hatch methods have preconditions. A mistaken call must not kill the worker.
	state := b.rt.Realm().CallState()
	defer func() {
		if recovered := recover(); recovered != nil {
			b.rt.Realm().RestoreCallState(state)
			if failure, ok := recovered.(error); ok {
				err = failure
			} else {
				err = wireError(fmt.Sprintf("native call: %v", recovered))
			}
			result = operationResult{}
		}
	}()
	var w wireValue
	switch op {
	case "nativeRoot":
		switch p.NativeRoot {
		case "runtime", "":
			w, err = b.encodeNative(reflect.ValueOf(b.rt))
		case "realm":
			w, err = b.encodeNative(reflect.ValueOf(b.rt.Realm()))
		case "engine", "moejs":
			w, err = b.encodeNative(reflect.ValueOf(nativePackageFunctions(p.NativeRoot)))
		default:
			err = wireError("unknown native root")
		}
	case "nativeTarget":
		var t reflect.Type
		t, err = nativeSchemaType(p.NativeType, 0)
		if err == nil {
			v := reflect.New(t)
			if p.Value.T != "" {
				var initial reflect.Value
				initial, err = b.convertNative(p.Value, t)
				if err == nil {
					v.Elem().Set(initial)
				}
			}
			if err == nil {
				w, err = b.encodeNative(v)
			}
		}
	case "nativeRelease":
		if p.Native.T != "native" {
			return operationResult{}, true, wireError("native operation requires a native handle")
		}
		delete(b.natives, p.Native.ID)
		w = wireValue{T: "undefined"}
	default:
		if p.Native.T != "native" {
			return operationResult{}, true, wireError("native operation requires a native handle")
		}
		var v reflect.Value
		v, err = b.nativeValue(p.Native.ID)
		if err != nil {
			break
		}
		switch op {
		case "nativeRead":
			w, err = b.nativeSnapshot(v, make(map[uintptr]bool), 0)
		case "nativeMethods":
			entries := make([]any, 0, v.NumMethod())
			for i := range v.NumMethod() {
				method := v.Type().Method(i)
				entries = append(entries, []any{method.Name, wireValue{T: "string", V: method.Type.String()}})
			}
			if v.Kind() == reflect.Map && v.Type().Key().Kind() == reflect.String {
				iter := v.MapRange()
				for iter.Next() {
					member := iter.Value()
					if member.Kind() == reflect.Interface {
						member = member.Elem()
					}
					entries = append(entries, []any{iter.Key().String(), wireValue{T: "string", V: member.Type().String()}})
				}
			}
			w = wireValue{T: "object", V: entries}
		case "nativeAsValue":
			var value moejs.Value
			value, err = b.nativeAsValue(v)
			if err == nil {
				w = b.retainValue(value)
			}
		case "nativeInvoke":
			method := v.MethodByName(p.Method)
			if !method.IsValid() && v.Kind() == reflect.Map && v.Type().Key().Kind() == reflect.String {
				method = v.MapIndex(reflect.ValueOf(p.Method).Convert(v.Type().Key()))
				if method.IsValid() && method.Kind() == reflect.Interface {
					method = method.Elem()
				}
			}
			w, err = b.nativeInvoke(method, p.NativeArgs)
		case "nativeCall":
			w, err = b.nativeInvoke(v, p.NativeArgs)
		case "nativeGetField", "nativeSetField":
			object := nativeIndirect(v)
			if object.IsValid() && object.Kind() == reflect.Map && object.Type().Key().Kind() == reflect.String && op == "nativeGetField" {
				field := object.MapIndex(reflect.ValueOf(p.Field).Convert(object.Type().Key()))
				if !field.IsValid() {
					err = wireError("unknown native namespace field " + p.Field)
				} else {
					w, err = b.encodeNative(field)
				}
				break
			}
			if !object.IsValid() || object.Kind() != reflect.Struct {
				err = wireError("native fields require a non-nil struct")
				break
			}
			field := object.FieldByName(p.Field)
			info, ok := object.Type().FieldByName(p.Field)
			if !ok || info.PkgPath != "" || !field.CanInterface() {
				err = wireError("unknown or unexported native field " + p.Field)
				break
			}
			if op == "nativeGetField" {
				w, err = b.encodeNative(field)
			} else {
				if !field.CanSet() {
					err = wireError("native field is not settable")
					break
				}
				var value reflect.Value
				value, err = b.convertNative(p.Value, field.Type())
				if err == nil {
					field.Set(value)
					w = wireValue{T: "undefined"}
				}
			}
		default:
			err = wireError("unknown native operation " + op)
		}
	}
	return operationResult{data: w}, true, err
}
