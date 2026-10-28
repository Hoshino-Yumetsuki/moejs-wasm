//go:build js && wasm

package main

import (
	"encoding/base64"
	"encoding/json"
	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/engine"
	"math/big"
	"reflect"
	"runtime"
	"runtime/debug"
	"time"
	"weak"
)

type hostFunctionOptions struct {
	Name   string
	Length int
	Async  bool
	Raw    bool
}
type valueState struct {
	values       map[int]moejs.Value
	valueObjects map[*moejs.Object]int
	valueSymbols map[*engine.Symbol]int
	nextValueID  int
	constructors map[string]moejs.Value
	// Symbols are held weakly: one neither side reaches can be recreated without anyone noticing.
	hostSymbols   map[int]weak.Pointer[engine.Symbol]
	symbolHostIDs map[weak.Pointer[engine.Symbol]]int
	nextSymbolID  int
	// Occurrences of each id in posted messages that the host has not released.
	valueSent map[int]int
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
	Count     int       `json:"count"`
	// Flat (id, count) pairs, and the script and module ids the host dropped.
	ReleaseValues  []int `json:"releaseValues"`
	ReleaseNatives []int `json:"releaseNatives"`
	ReleaseScripts []int `json:"releaseScripts"`
	ReleaseModules []int `json:"releaseModules"`
	// keyValue carries keys that are not well-formed strings.
	KeyValue   wireValue        `json:"keyValue"`
	Receiver   wireValue        `json:"receiver"`
	NewTarget  wireValue        `json:"newTarget"`
	Descriptor *valueDescriptor `json:"descriptor"`
	Hint       string           `json:"hint"`
}

func (b *bridge) initializeValues() {
	b.values = make(map[int]moejs.Value)
	b.valueObjects = make(map[*moejs.Object]int)
	b.valueSymbols = make(map[*engine.Symbol]int)
	b.constructors = make(map[string]moejs.Value)
	b.hostSymbols = make(map[int]weak.Pointer[engine.Symbol])
	b.symbolHostIDs = make(map[weak.Pointer[engine.Symbol]]int)
	b.valueSent = make(map[int]int)
	for _, name := range []string{"Symbol", "SharedArrayBuffer", "Date", "Map", "Set", "RegExp", "Error", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"} {
		v, err := b.rt.Get(engine.ObjectValue(b.rt.Realm().Global), name)
		if err == nil {
			b.constructors[name] = v
		}
	}
}
func (b *bridge) retainValue(v moejs.Value) wireValue {
	switch v.Type() {
	case engine.TypeUndefined, engine.TypeNull, engine.TypeBoolean, engine.TypeNumber:
		// These do not allocate upstream, so their handles carry the value and take no slot.
		leaf, _ := b.encodeLeaf(v)
		return wireValue{T: "ref", Kind: engine.TypeOf(v).GoString(), V: leaf}
	}
	if b.values == nil {
		b.initializeValues()
	}
	if v.IsObject() {
		if id := b.valueObjects[v.AsObject()]; id != 0 {
			b.valueSent[id]++
			return wireValue{T: "ref", ID: id, Kind: v.AsObject().ClassName()}
		}
	}
	if v.Type() == engine.TypeSymbol {
		if id := b.valueSymbols[v.AsSymbol()]; id != 0 {
			b.valueSent[id]++
			return wireValue{T: "ref", ID: id, Kind: "symbol"}
		}
	}
	b.nextValueID++
	id := b.nextValueID
	b.values[id] = v
	b.valueSent[id] = 1
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

// retainArgument is a live handle for a raw host call; its occurrence expires with the call.
func (b *bridge) retainArgument(v moejs.Value, temps *[]int) wireValue {
	w := b.retainValue(v)
	if w.ID != 0 {
		w.Temporary = true
		*temps = append(*temps, w.ID)
	}
	return w
}

// releaseTemporaries drops a call's argument occurrences; handles the host got another way stay.
func (b *bridge) releaseTemporaries(ids []int) {
	for _, id := range ids {
		b.unretainValue(id, 1)
	}
}

// unretainValue releases count posted occurrences of id; count <= 0 releases them all.
func (b *bridge) unretainValue(id, count int) {
	if n := b.valueSent[id]; count > 0 && n > count {
		b.valueSent[id] = n - count
		return
	}
	v, ok := b.values[id]
	delete(b.valueSent, id)
	if !ok {
		return
	}
	delete(b.values, id)
	if v.IsObject() && b.valueObjects[v.AsObject()] == id {
		delete(b.valueObjects, v.AsObject())
	}
	if v.Type() == engine.TypeSymbol && b.valueSymbols[v.AsSymbol()] == id {
		delete(b.valueSymbols, v.AsSymbol())
	}
}

// releaseHandles applies a batched release; it never responds.
func (b *bridge) releaseHandles(p *payload) {
	for i := 0; i+1 < len(p.ReleaseValues); i += 2 {
		b.unretainValue(p.ReleaseValues[i], p.ReleaseValues[i+1])
	}
	for i := 0; i+1 < len(p.ReleaseNatives); i += 2 {
		b.unretainNative(p.ReleaseNatives[i], p.ReleaseNatives[i+1])
	}
	for _, id := range p.ReleaseScripts {
		b.releaseScript(id)
	}
	for _, id := range p.ReleaseModules {
		b.releaseModule(id)
	}
}

func (b *bridge) releaseValues() {
	clear(b.values)
	clear(b.valueSent)
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
func (b *bridge) callFunctionValue(p *payload) (operationResult, error) {
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
func (b *bridge) dispatchValues(op string, p *payload) (operationResult, bool, error) {
	switch op {
	case "valueFromHost", "valueParseJSON", "valueGet", "valueHas", "valueExport", "valueCall", "valueJSON", "valueToGo", "valueUnmarshal", "valueToGoInto", "valueRelease":
	case "valuePure":
		r, e := b.valuePure(p)
		return r, true, e
	case "valueOp":
		r, e := b.valueOp(p)
		return r, true, e
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
		b.unretainValue(p.Value.ID, p.Count)
		return operationResult{}, true, nil
	case "valueGet":
		key, e := b.payloadKey(p)
		if e != nil {
			return operationResult{}, true, e
		}
		r := b.rt.Realm()
		switch {
		case p.Receiver.T != "":
			o, e := objectFor(v, "Get")
			if e != nil {
				return operationResult{}, true, e
			}
			receiver, e := b.decode(p.Receiver, true, 0)
			if e != nil {
				return operationResult{}, true, e
			}
			v, err = o.Get(r, key, receiver)
		case v.IsNullish():
			// Runtime.Get reads undefined from nullish values.
			v = moejs.Undefined()
		default:
			v, err = r.GetV(v, key)
		}
		return result(v, p.Raw, err)
	case "valueHas":
		key, e := b.payloadKey(p)
		if e != nil {
			return operationResult{}, true, e
		}
		ok, e := b.rt.Realm().HasPropertyIn(key.Value(), v)
		return operationResult{data: ok}, true, e
	case "valueExport":
		// Do not auto-await a Promise while exporting a handle.
		w, e := b.encode(v)
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
			return operationResult{}, true, nil
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
			return wireValue{}, errWireDepth
		}
		switch x := value.(type) {
		case *engine.Object:
			return b.retainValue(engine.ObjectValue(x)), nil
		case *engine.Symbol:
			return b.retainValue(engine.SymbolValue(x)), nil
		case *big.Int:
			return wireValue{T: "bigint", V: x.String()}, nil
		case time.Time:
			n, e := b.encode(moejs.Number(float64(x.UnixMilli())))
			return wireValue{T: "date", V: n}, e
		case json.RawMessage:
			if x == nil {
				return wireValue{T: "null"}, nil
			}
			return wireValue{T: "rawjson", V: string(x)}, nil
		case []byte:
			if x == nil {
				return wireValue{T: "null"}, nil
			}
			return wireValue{T: "buffer", V: base64Text(base64.StdEncoding.EncodeToString(x))}, nil
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
				pairs := make([]wireEntry, 0, rv.Len())
				iter := rv.MapRange()
				for iter.Next() {
					if iter.Key().Kind() != reflect.String {
						return wireValue{}, wireError("native result has unsupported map keys")
					}
					item, e := visit(iter.Value().Interface(), depth+1)
					if e != nil {
						return wireValue{}, e
					}
					pairs = append(pairs, wireEntry{iter.Key().String(), item})
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

// releaseScript drops a Script descriptor's bytecode once the host can no longer run it.
func (b *bridge) releaseScript(id int) {
	code := b.scripts[id]
	if code == nil {
		return
	}
	delete(b.scripts, id)
	if script := b.nativeScripts[code]; script != nil {
		delete(b.moduleByNative, script)
		delete(b.nativeScripts, code)
	}
}

// releaseModule drops a module's bytecode on the compiler once no descriptor or graph names it.
func (b *bridge) releaseModule(id int) {
	if b.rt != nil {
		return
	}
	if mod := b.modules[id]; mod != nil {
		delete(b.moduleByNative, mod.native)
		delete(b.modules, id)
	}
}

type symbolKey struct {
	id int
	wp weak.Pointer[engine.Symbol]
}

func (b *bridge) trackSymbol(id int, symbol *engine.Symbol) {
	wp := weak.Make(symbol)
	b.hostSymbols[id] = wp
	b.symbolHostIDs[wp] = id
	runtime.AddCleanup(symbol, b.symbolCollected, symbolKey{id, wp})
}

func (b *bridge) symbolCollected(k symbolKey) {
	b.releaseMu.Lock()
	b.releasedSymbols = append(b.releasedSymbols, k)
	b.releaseMu.Unlock()
}

// drainSymbols forgets collected symbols on the dispatch goroutine, which owns the maps.
func (b *bridge) drainSymbols() {
	b.releaseMu.Lock()
	keys := b.releasedSymbols
	b.releasedSymbols = nil
	b.releaseMu.Unlock()
	for _, k := range keys {
		if b.hostSymbols[k.id] == k.wp {
			delete(b.hostSymbols, k.id)
		}
		if b.symbolHostIDs[k.wp] == k.id {
			delete(b.symbolHostIDs, k.wp)
		}
	}
}

// retentionStats backs the internal debugRetention op: what the bridge still holds after a collection.
func (b *bridge) retentionStats() map[string]any {
	runtime.GC()
	runtime.GC()
	// Cleanups run on their own goroutine; let it finish.
	for i, live := 0, int64(-1); i < 10 && live != b.liveCallbacks.Load(); i++ {
		live = b.liveCallbacks.Load()
		runtime.Gosched()
	}
	b.drainSymbols()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	gcPercent := debug.SetGCPercent(-1)
	debug.SetGCPercent(gcPercent)
	return map[string]any{"values": len(b.values), "natives": len(b.natives), "callbacks": b.liveCallbacks.Load(), "symbols": len(b.hostSymbols), "scripts": len(b.scripts), "modules": len(b.modules), "heap": int64(mem.HeapAlloc), "gcPercent": gcPercent, "goMemoryLimit": debug.SetMemoryLimit(-1)}
}
