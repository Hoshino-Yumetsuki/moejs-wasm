//go:build js && wasm

package main

import (
	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/engine"
	"math/big"
	"reflect"
	"time"
)

type hostFunctionOptions struct {
	Name   string
	Length int
	Async  bool
}
type valueState struct {
	values           map[int]moejs.Value
	valueObjects     map[*moejs.Object]int
	valueSymbols     map[*engine.Symbol]int
	nextValueID      int
	removeValueRoots func()
	constructors     map[string]moejs.Value
	hostSymbols      map[int]*engine.Symbol
	symbolHostIDs    map[*engine.Symbol]int
	nextSymbolID     int
}
type valuePayload struct {
	ThisValue wireValue `json:"thisValue"`
	Key       string    `json:"key"`
	JSON      string    `json:"json"`
	Prefix    string    `json:"prefix"`
	Strict    bool      `json:"strict"`
	Raw       bool      `json:"raw"`
	MaxBytes  int       `json:"maxBytes"`
	MaxNodes  int       `json:"maxNodes"`
}

func (b *bridge) initializeValues() {
	b.values = make(map[int]moejs.Value)
	b.valueObjects = make(map[*moejs.Object]int)
	b.valueSymbols = make(map[*engine.Symbol]int)
	b.constructors = make(map[string]moejs.Value)
	b.hostSymbols = make(map[int]*engine.Symbol)
	b.symbolHostIDs = make(map[*engine.Symbol]int)
	for _, name := range []string{"Symbol", "SharedArrayBuffer", "Date", "Map", "Set", "RegExp", "Error", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Reflect"} {
		v, err := b.rt.Get(engine.ObjectValue(b.rt.Realm().Global), name)
		if err == nil {
			b.constructors[name] = v
		}
	}
	b.removeValueRoots = b.rt.AddLiveRoots(func(add func(moejs.Value)) {
		for _, v := range b.values {
			add(v)
		}
		for _, symbol := range b.hostSymbols {
			add(engine.SymbolValue(symbol))
		}
		for _, v := range b.constructors {
			add(v)
		}
	})
}
func (b *bridge) retainValue(v moejs.Value) wireValue {
	if b.values == nil {
		b.initializeValues()
	}
	if v.IsObject() {
		if id := b.valueObjects[v.AsObject()]; id != 0 {
			return wireValue{T: "ref", ID: id, Kind: v.AsObject().ClassName()}
		}
	}
	if v.Type() == engine.TypeSymbol {
		if id := b.valueSymbols[v.AsSymbol()]; id != 0 {
			return wireValue{T: "ref", ID: id, Kind: "symbol"}
		}
	}
	b.nextValueID++
	id := b.nextValueID
	b.values[id] = v
	kind := engine.TypeOf(v).GoString()
	if v.IsObject() {
		b.valueObjects[v.AsObject()] = id
		kind = v.AsObject().ClassName()
	}
	if v.Type() == engine.TypeSymbol {
		b.valueSymbols[v.AsSymbol()] = id
	}
	return wireValue{T: "ref", ID: id, Kind: kind}
}
func (b *bridge) releaseValues() {
	if b.removeValueRoots != nil {
		b.removeValueRoots()
		b.removeValueRoots = nil
	}
	clear(b.values)
	clear(b.valueObjects)
	clear(b.valueSymbols)
	clear(b.hostSymbols)
	clear(b.symbolHostIDs)
	clear(b.constructors)
}
func (b *bridge) constructValue(name string, args ...moejs.Value) (moejs.Value, error) {
	ctor, ok := b.constructors[name]
	if !ok {
		return moejs.Undefined(), wireError("unsupported native constructor " + name)
	}
	return b.rt.Realm().Construct(ctor, args, ctor.AsObject())
}
func (b *bridge) methodValue(v moejs.Value, name string, args ...moejs.Value) (moejs.Value, error) {
	fn, err := b.rt.Get(v, name)
	if err != nil {
		return moejs.Undefined(), err
	}
	return b.rt.CallFunction(fn, v, args...)
}
func (b *bridge) callFunctionValue(p payload) (operationResult, error) {
	fn, err := b.decode(p.Value, true, 0)
	if err != nil {
		return operationResult{}, err
	}
	this, err := b.decode(p.ThisValue, true, 0)
	if p.ThisValue.T == "" {
		this, err = moejs.Undefined(), nil
	}
	if err != nil {
		return operationResult{}, err
	}
	args := make([]moejs.Value, len(p.Args))
	for i, w := range p.Args {
		args[i], err = b.decode(w, true, 0)
		if err != nil {
			return operationResult{}, err
		}
	}
	v, err := b.rt.CallFunction(fn, this, args...)
	return operationResult{value: v, hasValue: true, raw: p.Raw}, err
}
func (b *bridge) dispatchValues(op string, p payload) (operationResult, bool, error) {
	switch op {
	case "valueFromHost", "valueParseJSON", "valueGet", "valueHas", "valueExport", "valueCall", "valueJSON", "valueToGo", "valueUnmarshal", "valueToGoInto", "valueRelease":
	default:
		return operationResult{}, false, nil
	}
	result := func(v moejs.Value, raw bool, err error) (operationResult, bool, error) {
		return operationResult{value: v, hasValue: true, raw: raw}, true, err
	}
	if op == "valueCall" {
		r, e := b.callFunctionValue(p)
		return r, true, e
	}
	if op == "valueParseJSON" {
		v, e := b.rt.ParseJSONString(p.JSON)
		return result(v, true, e)
	}
	v, err := b.decode(p.Value, true, 0)
	if err != nil {
		return operationResult{}, true, err
	}
	switch op {
	case "valueFromHost":
		return result(v, true, nil)
	case "valueRelease":
		if p.Value.T != "ref" {
			return operationResult{}, true, wireError("release requires a guest reference")
		}
		delete(b.values, p.Value.ID)
		if v.IsObject() {
			delete(b.valueObjects, v.AsObject())
		}
		if v.Type() == engine.TypeSymbol {
			delete(b.valueSymbols, v.AsSymbol())
		}
		return operationResult{}, true, nil
	case "valueGet":
		v, err = b.rt.Get(v, p.Key)
		return result(v, p.Raw, err)
	case "valueHas":
		reflect := b.constructors["Reflect"]
		key, e := b.rt.FromGo(p.Key)
		if e != nil {
			return operationResult{}, true, e
		}
		res, e := b.methodValue(reflect, "has", v, key)
		return operationResult{data: res.Type() == engine.TypeBoolean && res.AsBool()}, true, e
	case "valueExport":
		// Do not auto-await a Promise while exporting a handle.
		w, e := b.encode(v, nil, 0)
		return operationResult{data: w}, true, e
	case "valueJSON":
		text, e := b.rt.AppendJSONWith([]byte(p.Prefix), v, moejs.JSONOptions{Strict: p.Strict})
		return operationResult{data: string(text)}, true, e
	case "valueToGo", "valueUnmarshal", "valueToGoInto":
		if p.MaxBytes < 0 || p.MaxNodes < 0 {
			return operationResult{}, true, wireError("decode limits must be nonnegative")
		}
		opts := moejs.DecodeOptions{MaxBytes: p.MaxBytes, MaxNodes: p.MaxNodes}
		if op != "valueToGo" && p.NativeTarget.T != "" {
			target, e := b.nativeDecodeTarget(p.NativeTarget)
			if e != nil {
				return operationResult{}, true, e
			}
			if op == "valueUnmarshal" {
				e = b.rt.UnmarshalWith(v, target, opts)
			} else {
				e = b.rt.ToGoIntoWith(v, target, opts)
			}
			if e != nil {
				return operationResult{}, true, decodeTargetError(target, e)
			}
			return operationResult{data: p.NativeTarget}, true, nil
		}
		var out any
		if op == "valueToGo" {
			out, err = b.rt.ToGoWith(v, opts)
		} else if op == "valueUnmarshal" {
			err = b.rt.UnmarshalWith(v, &out, opts)
		} else {
			err = b.rt.ToGoIntoWith(v, &out, opts)
		}
		if err != nil {
			return operationResult{}, true, err
		}
		w, e := b.encodeConverted(out)
		return operationResult{data: w}, true, e
	}
	return operationResult{}, true, wireError("invalid value operation")
}

// encodeConverted transports native results without another JSON or FromGo conversion.
func (b *bridge) encodeConverted(value any) (wireValue, error) {
	type identity struct {
		kind    reflect.Kind
		pointer uintptr
	}
	seen := make(map[identity]int)
	convertedObjects := make(map[*moejs.Object]int)
	var visit func(any, int) (wireValue, error)
	visit = func(value any, depth int) (wireValue, error) {
		if depth > 10000 {
			return wireValue{}, wireError("wire value nesting exceeds 10000 levels")
		}
		switch x := value.(type) {
		case *engine.Object:
			return b.retainValue(engine.ObjectValue(x)), nil
		case *engine.Symbol:
			return b.retainValue(engine.SymbolValue(x)), nil
		case *big.Int:
			return wireValue{T: "bigint", V: x.String()}, nil
		case time.Time:
			n, e := b.encode(moejs.Number(float64(x.UnixMilli())), nil, 0)
			return wireValue{T: "date", V: n}, e
		case []byte:
			if x == nil {
				return wireValue{T: "null"}, nil
			}
			data := make([]int, len(x))
			for i, n := range x {
				data[i] = int(n)
			}
			return wireValue{T: "buffer", V: data}, nil
		}
		rv := reflect.ValueOf(value)
		if rv.IsValid() && (rv.Kind() == reflect.Map || rv.Kind() == reflect.Slice || rv.Kind() == reflect.Array) {
			if rv.Kind() != reflect.Array && rv.IsNil() {
				return wireValue{T: "null"}, nil
			}
			id := 0
			if rv.Kind() != reflect.Array {
				key := identity{rv.Kind(), uintptr(rv.UnsafePointer())}
				if old := seen[key]; old != 0 {
					return wireValue{T: "link", ID: old}, nil
				}
				id = len(seen) + 1
				seen[key] = id
			}
			if rv.Kind() == reflect.Map {
				pairs := make([][2]any, 0, rv.Len())
				iter := rv.MapRange()
				for iter.Next() {
					if iter.Key().Kind() != reflect.String {
						return wireValue{}, wireError("native result has unsupported map keys")
					}
					item, e := visit(iter.Value().Interface(), depth+1)
					if e != nil {
						return wireValue{}, e
					}
					pairs = append(pairs, [2]any{iter.Key().String(), item})
				}
				return wireValue{T: "object", ID: id, V: pairs}, nil
			}
			items := make([]wireValue, rv.Len())
			for i := range items {
				item, e := visit(rv.Index(i).Interface(), depth+1)
				if e != nil {
					return wireValue{}, e
				}
				items[i] = item
			}
			return wireValue{T: "array", ID: id, V: items}, nil
		}
		v, e := b.rt.FromGo(value)
		if e != nil {
			return wireValue{}, e
		}
		return b.encodeTree(v, convertedObjects, depth)
	}
	out, err := visit(value, 0)
	if err != nil {
		return wireValue{}, err
	}
	return flattenWire(out), nil
}
