//go:build js && wasm

package main

import (
	"encoding/base64"
	"encoding/json"
	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/engine"
	"math"
	"math/big"
	"reflect"
	"strings"
	"weak"
)

// Digits of 2^(1<<20): a longer canonical decimal always exceeds upstream's maxBigIntBits.
const maxBigIntDigits = 315653

type wireValue struct {
	T         string     `json:"t"`
	V         any        `json:"v,omitempty"`
	ID        int        `json:"id"`
	Kind      string     `json:"kind,omitempty"`
	Offset    int        `json:"offset"`
	Length    int        `json:"length"`
	Name      string     `json:"name,omitempty"`
	Async     *bool      `json:"async,omitempty"`
	Temporary bool       `json:"temporary,omitempty"`
	Raw       bool       `json:"raw,omitempty"`
	Root      *wireValue `json:"root,omitempty"`
}

func wireError(message string) error { return &bridgeError{message} }

type bridgeError struct{ message string }

func (e *bridgeError) Error() string { return e.message }

func readWire(v any) (wireValue, error) {
	w, ok := v.(wireValue)
	if !ok {
		return wireValue{}, wireError("invalid tagged wire value")
	}
	if w.T == "" {
		return wireValue{}, wireError("wire value has no type")
	}
	return w, nil
}
func (b *bridge) decode(w wireValue, functions bool, depth int) (moejs.Value, error) {
	if w.T == "graph" {
		return b.decodeFlatGraph(w, functions)
	}
	return b.decodeGraph(w, functions, depth, make(map[int]moejs.Value))
}

type wireDecoder struct {
	b         *bridge
	functions bool
	seen      map[int]moejs.Value
	graph     *flatGraph
}

func (b *bridge) decodeGraph(w wireValue, functions bool, depth int, seen map[int]moejs.Value) (moejs.Value, error) {
	return (&wireDecoder{b: b, functions: functions, seen: seen}).value(w, depth)
}

func (d *wireDecoder) value(w wireValue, depth int) (moejs.Value, error) {
	b, functions, seen := d.b, d.functions, d.seen
	if depth > 10000 {
		return moejs.Undefined(), errWireDepth
	}
	child := func(v any) (moejs.Value, error) {
		x, e := readWire(v)
		if e != nil {
			return moejs.Undefined(), e
		}
		return d.value(x, depth+1)
	}
	remember := func(v moejs.Value) moejs.Value {
		if w.ID > 0 {
			seen[w.ID] = v
		}
		return v
	}
	s, _ := w.V.(string)
	r := b.rt.Realm()
	switch w.T {
	case "undefined":
		return moejs.Undefined(), nil
	case "null":
		return moejs.Null(), nil
	case "boolean":
		if v, ok := w.V.(bool); ok {
			return moejs.Bool(v), nil
		}
	case "string":
		if _, ok := w.V.(string); ok {
			return moejs.String(s), nil
		}
	case "string16":
		items, ok := w.V.([]any)
		if !ok {
			break
		}
		units := make([]uint16, len(items))
		for i, x := range items {
			n, ok := x.(float64)
			if !ok || n < 0 || n > 65535 || n != math.Trunc(n) {
				return moejs.Undefined(), wireError("invalid UTF16 code unit")
			}
			units[i] = uint16(n)
		}
		return engine.StringValue(engine.FromUTF16(units)), nil
	case "number":
		if n, ok := w.V.(float64); ok {
			return moejs.Number(n), nil
		}
		switch s {
		case "NaN":
			return moejs.Number(math.NaN()), nil
		case "Infinity":
			return moejs.Number(math.Inf(1)), nil
		case "-Infinity":
			return moejs.Number(math.Inf(-1)), nil
		case "-0":
			return moejs.Number(math.Copysign(0, -1)), nil
		}
	case "bigint":
		if digits := strings.TrimLeft(strings.TrimLeft(s, "+-"), "0"); len(digits) > maxBigIntDigits {
			return moejs.Undefined(), r.RangeError("Maximum BigInt size exceeded")
		}
		x, ok := new(big.Int).SetString(s, 10)
		if !ok {
			break
		}
		n, ok := engine.NewBigIntFromBig(x)
		if !ok {
			return moejs.Undefined(), r.RangeError("Maximum BigInt size exceeded")
		}
		return engine.BigIntValue(n), nil
	case "ref":
		if w.ID == 0 && w.V != nil {
			leaf, e := readWire(w.V)
			if e != nil || leaf.T == "ref" {
				return moejs.Undefined(), wireError("invalid inline guest reference")
			}
			return d.value(leaf, depth+1)
		}
		if v, ok := b.values[w.ID]; ok && w.ID > 0 {
			return v, nil
		}
		return moejs.Undefined(), wireError("unknown or released guest reference")
	case "link":
		if v, ok := seen[w.ID]; ok {
			return v, nil
		}
		if d.graph != nil {
			if index, ok := d.graph.deferred[w.ID]; ok {
				return d.resolve(index)
			}
		}
		return moejs.Undefined(), wireError("invalid graph reference")
	case "node":
		if d.graph != nil && w.ID >= 0 && w.ID < len(d.graph.nodes) {
			return d.resolve(w.ID)
		}
		return moejs.Undefined(), wireError("invalid graph node")
	case "function":
		cb, ok := w.V.(*hostCallback)
		if !functions || !ok {
			return moejs.Undefined(), wireError("host function registration is unavailable")
		}
		opts := hostFunctionOptions{Name: w.Name, Length: w.Length, Async: true, Raw: w.Raw}
		if w.Async != nil {
			opts.Async = *w.Async
		}
		return b.hostFunction(cb, opts), nil
	case "symbol":
		return b.decodeSymbol(w)
	case "array", "object", "map", "set", "error":
		items, ok := w.V.([]any)
		if !ok {
			break
		}
		value, exists := seen[w.ID]
		if !exists {
			var err error
			if value, err = b.newContainer(w.T); err != nil {
				return moejs.Undefined(), err
			}
			remember(value)
		}
		for i, item := range items {
			if w.T == "array" {
				v, e := child(item)
				if e != nil {
					return moejs.Undefined(), e
				}
				o := value.AsObject()
				if o.ArrayLength() == uint32(i) && o.Push(r, v) {
					continue
				}
				if e = o.CreateDataPropertyOrThrow(r, engine.IndexKey(uint32(i)), v); e != nil {
					return moejs.Undefined(), e
				}
				continue
			}
			if w.T == "set" {
				v, e := child(item)
				if e != nil {
					return moejs.Undefined(), e
				}
				if _, e = b.methodValue(value, "add", v); e != nil {
					return moejs.Undefined(), e
				}
				continue
			}
			pair, ok := item.([]any)
			if !ok || len(pair) != 2 {
				return moejs.Undefined(), wireError("invalid wire entry")
			}
			if w.T == "map" {
				key, e := child(pair[0])
				if e != nil {
					return moejs.Undefined(), e
				}
				v, e := child(pair[1])
				if e != nil {
					return moejs.Undefined(), e
				}
				if _, e = b.methodValue(value, "set", key, v); e != nil {
					return moejs.Undefined(), e
				}
				continue
			}
			v, e := child(pair[1])
			if e != nil {
				return moejs.Undefined(), e
			}
			var key engine.PropertyKey
			if text, ok := pair[0].(string); ok {
				key = r.KeyFromGoString(text)
			} else {
				text, e := child(pair[0])
				if e != nil {
					return moejs.Undefined(), e
				}
				if text.IsSymbol() {
					key = engine.SymbolKey(text.AsSymbol())
				} else if text.IsString() {
					key = r.KeyFromString(text.AsString())
				} else {
					return moejs.Undefined(), wireError("invalid object key")
				}
			}
			if e = value.AsObject().CreateDataPropertyOrThrow(r, key, v); e != nil {
				return moejs.Undefined(), e
			}
		}
		return value, nil
	case "date":
		n, e := child(w.V)
		if e != nil {
			return moejs.Undefined(), e
		}
		v, e := b.constructValue("Date", n)
		return remember(v), e
	case "regexp":
		items, ok := w.V.([]any)
		if !ok || len(items) != 3 {
			break
		}
		pattern, e := child(items[0])
		if e != nil {
			return moejs.Undefined(), e
		}
		flags, e := child(items[1])
		if e != nil {
			return moejs.Undefined(), e
		}
		v, e := b.constructValue("RegExp", pattern, flags)
		if e != nil {
			return moejs.Undefined(), e
		}
		remember(v)
		index, e := child(items[2])
		if e != nil {
			return moejs.Undefined(), e
		}
		e = v.AsObject().SetProp(r, r.KeyFromGoString("lastIndex"), index)
		return v, e
	case "buffer":
		data, err := wireBytes(w)
		if err != nil {
			return moejs.Undefined(), err
		}
		var o *engine.Object
		var e error
		if w.Kind == "SharedArrayBuffer" {
			shared, err := b.constructValue("SharedArrayBuffer", moejs.Number(float64(len(data))))
			if err != nil {
				return moejs.Undefined(), err
			}
			o = shared.AsObject()
			target, _ := o.BufferData()
			copy(target, data)
		} else {
			o, e = r.NewArrayBuffer(data)
		}
		if e != nil {
			return moejs.Undefined(), e
		}
		return remember(engine.ObjectValue(o)), nil
	case "view":
		buffer, e := child(w.V)
		if e != nil {
			return moejs.Undefined(), e
		}
		v, e := b.constructValue(w.Kind, buffer, moejs.Number(float64(w.Offset)), moejs.Number(float64(w.Length)))
		return remember(v), e
	case "guest":
		// Internal only: the parser never puts a Value in V.
		if v, ok := w.V.(moejs.Value); ok {
			return v, nil
		}
		return moejs.Undefined(), wireError("invalid wire value of type guest")
	case "native", "goValue":
		// A Go value converts as upstream SetGlobal and FromGo convert it; goValue is a pinned one.
		v, e := b.nativeValue(w.ID)
		if pinned, ok := w.V.(reflect.Value); ok && w.T == "goValue" {
			v, e = pinned, nil
		}
		if e != nil {
			return moejs.Undefined(), e
		}
		if gv, e := b.nativeAsValue(v); e == nil {
			return gv, nil
		}
		return b.rt.FromGo(v.Interface())
	case "rawjson":
		return b.rt.FromGo(json.RawMessage(s))
	}
	return moejs.Undefined(), wireError("invalid wire value of type " + w.T)
}

// Breadth-first graph nodes keep nesting off the Go and JSON stacks.
func (b *bridge) encode(v moejs.Value) (wireValue, error) {
	if err := b.rt.Realm().CheckInterrupt(); err != nil {
		return wireValue{}, err
	}
	type item struct {
		value     moejs.Value
		id, depth int
	}
	var queue []item
	identities := make(map[*moejs.Object]int)
	depth := -1
	child := func(value moejs.Value) (wireValue, error) {
		id, inline, err := b.identify(value, identities)
		if id == 0 {
			return inline, err
		}
		queue = append(queue, item{value, id, depth + 1})
		return wireValue{T: "node", ID: len(queue) - 1}, nil
	}
	root, err := child(v)
	if err != nil || root.T != "node" {
		return root, err
	}
	keys := make(map[engine.PropertyKey]any)
	nodes := append(make([]byte, 0, 1024), '[')
	for index := 0; index < len(queue); index++ {
		current := queue[index]
		depth = current.depth
		if err := b.nodeCheck(depth); err != nil {
			return wireValue{}, err
		}
		node, err := b.encodeObject(current.value, current.id, child, keys)
		if err != nil {
			return wireValue{}, err
		}
		if index != 0 {
			nodes = append(nodes, ',')
		}
		nodes = node.appendJSON(nodes)
	}
	return wireValue{T: "graph", V: rawJSON(append(nodes, ']')), Root: &root}, nil
}

func copiedClass(class engine.Class) bool {
	switch class {
	case engine.ClassObject, engine.ClassArray, engine.ClassMap, engine.ClassSet, engine.ClassDate, engine.ClassRegExp, engine.ClassError, engine.ClassArrayBuffer, engine.ClassSharedArrayBuffer, engine.ClassTypedArray, engine.ClassDataView:
		return true
	}
	return false
}

func (b *bridge) identify(v moejs.Value, seen map[*moejs.Object]int) (int, wireValue, error) {
	if !v.IsObject() || !copiedClass(v.AsObject().Class()) {
		leaf, err := b.encodeLeaf(v)
		return 0, leaf, err
	}
	o := v.AsObject()
	if id := seen[o]; id != 0 {
		return 0, wireValue{T: "link", ID: id}, nil
	}
	id := len(seen) + 1
	seen[o] = id
	return id, wireValue{}, nil
}

func (b *bridge) nodeCheck(depth int) error {
	if depth > 10000 {
		return errWireDepth
	}
	return b.rt.Realm().CheckInterrupt()
}

func (b *bridge) encodeLeaf(v moejs.Value) (wireValue, error) {
	switch v.Type() {
	case engine.TypeUndefined:
		return wireValue{T: "undefined"}, nil
	case engine.TypeNull:
		return wireValue{T: "null"}, nil
	case engine.TypeBoolean:
		return wireValue{T: "boolean", V: v.AsBool()}, nil
	case engine.TypeString:
		return encodeString(v.AsString()), nil
	case engine.TypeNumber:
		n := v.AsNumber()
		var out any = n
		switch {
		case math.IsNaN(n):
			out = "NaN"
		case math.IsInf(n, 1):
			out = "Infinity"
		case math.IsInf(n, -1):
			out = "-Infinity"
		case n == 0 && math.Signbit(n):
			out = "-0"
		}
		return wireValue{T: "number", V: out}, nil
	case engine.TypeBigInt:
		return wireValue{T: "bigint", V: v.AsBigInt().ToString()}, nil
	case engine.TypeSymbol:
		return b.encodeSymbol(v.AsSymbol()), nil
	case engine.TypeObject:
		return b.retainValue(v), nil
	}
	return wireValue{}, wireError("unsupported guest primitive")
}

func (b *bridge) encodeObject(v moejs.Value, id int, child func(moejs.Value) (wireValue, error), keyCache map[engine.PropertyKey]any) (wireValue, error) {
	o := v.AsObject()
	class := o.Class()
	get := func(key string) (wireValue, error) {
		x, e := b.rt.Get(v, key)
		if e != nil {
			return wireValue{}, e
		}
		return child(x)
	}
	switch class {
	case engine.ClassDate:
		n, _ := o.DateValue()
		x, e := child(moejs.Number(n))
		return wireValue{T: "date", ID: id, V: x}, e
	case engine.ClassRegExp:
		// The internal source and flags, as structured clone reads them; getters cannot spoof them.
		if d := o.RegExpData(); d != nil {
			if index, ok := o.GetOwnDataValue(keyLastIndex); ok {
				last, e := child(index)
				return wireValue{T: "regexp", ID: id, V: []wireValue{encodeString(d.Source()), encodeString(d.Flags()), last}}, e
			}
		}
		source, e := get("source")
		if e != nil {
			return wireValue{}, e
		}
		flags, e := get("flags")
		if e != nil {
			return wireValue{}, e
		}
		index, e := get("lastIndex")
		if e != nil {
			return wireValue{}, e
		}
		return wireValue{T: "regexp", ID: id, V: []wireValue{source, flags, index}}, nil
	case engine.ClassArrayBuffer, engine.ClassSharedArrayBuffer:
		data, _ := o.BufferData()
		return wireValue{T: "buffer", ID: id, V: base64Text(base64.StdEncoding.EncodeToString(data)), Kind: o.ClassName()}, nil
	case engine.ClassTypedArray, engine.ClassDataView:
		buffer, e := get("buffer")
		if e != nil {
			return wireValue{}, e
		}
		offset, e := b.rt.Get(v, "byteOffset")
		if e != nil {
			return wireValue{}, e
		}
		kind := "DataView"
		lengthKey := "byteLength"
		if class == engine.ClassTypedArray {
			ctor, e := b.rt.Get(v, "constructor")
			if e != nil {
				return wireValue{}, e
			}
			name, e := b.rt.Get(ctor, "name")
			if e != nil {
				return wireValue{}, e
			}
			kind = name.AsString().GoString()
			lengthKey = "length"
		}
		length, e := b.rt.Get(v, lengthKey)
		if e != nil {
			return wireValue{}, e
		}
		return wireValue{T: "view", ID: id, V: buffer, Kind: kind, Offset: int(offset.AsNumber()), Length: int(length.AsNumber())}, nil
	case engine.ClassArray:
		r := b.rt.Realm()
		items := make([]wireValue, o.ArrayLength())
		for i := range items {
			x, e := o.GetIndex(r, uint32(i))
			if e != nil {
				return wireValue{}, e
			}
			if items[i], e = child(x); e != nil {
				return wireValue{}, e
			}
		}
		return wireValue{T: "array", ID: id, V: items}, nil
	case engine.ClassMap, engine.ClassSet:
		r := b.rt.Realm()
		method := "entries"
		tag := "map"
		if class == engine.ClassSet {
			method = "values"
			tag = "set"
		}
		iterator, e := b.methodValue(v, method)
		if e != nil {
			return wireValue{}, e
		}
		// Like GetIterator, read next once.
		next, e := b.rt.Get(iterator, "next")
		if e != nil {
			return wireValue{}, e
		}
		items := make([]any, 0)
		for {
			result, e := b.rt.CallFunction(next, iterator)
			if e != nil {
				return wireValue{}, e
			}
			done, e := r.GetV(result, keyDone)
			if e != nil {
				return wireValue{}, e
			}
			if done.AsBool() {
				break
			}
			item, e := r.GetV(result, keyValue)
			if e != nil {
				return wireValue{}, e
			}
			if class == engine.ClassMap {
				key, e := r.GetV(item, engine.IndexKey(0))
				if e != nil {
					return wireValue{}, e
				}
				val, e := r.GetV(item, engine.IndexKey(1))
				if e != nil {
					return wireValue{}, e
				}
				a, e := child(key)
				if e != nil {
					return wireValue{}, e
				}
				z, e := child(val)
				if e != nil {
					return wireValue{}, e
				}
				items = append(items, [2]wireValue{a, z})
			} else {
				x, e := child(item)
				if e != nil {
					return wireValue{}, e
				}
				items = append(items, x)
			}
		}
		return wireValue{T: tag, ID: id, V: items}, nil
	}
	r := b.rt.Realm()
	keys := o.OwnEnumerableStringKeys()
	entries := make([]wireEntry, 0, len(keys))
	entry := func(key engine.PropertyKey) error {
		val, e := o.GetProp(r, key)
		if e != nil {
			return e
		}
		item, e := child(val)
		if e != nil {
			return e
		}
		entries = append(entries, wireEntry{b.encodeKey(key, keyCache), item})
		return nil
	}
	named := 0
	for _, key := range keys {
		if !key.IsIndex() {
			named++
		}
		if e := entry(key); e != nil {
			return wireValue{}, e
		}
	}
	if shape := o.Shape(); shape.IsDictionary() || shape.Count() != named {
		for _, key := range o.OwnPropertyKeys() {
			if desc, ok := o.GetOwnProperty(key); ok && key.IsSymbol() && desc.Enumerable() {
				if e := entry(key); e != nil {
					return wireValue{}, e
				}
			}
		}
	}
	if class != engine.ClassError {
		return wireValue{T: "object", ID: id, V: entries}, nil
	}
	for _, key := range errorKeys {
		if desc, ok := o.GetOwnProperty(key); !ok || !desc.Enumerable() {
			if e := entry(key); e != nil {
				return wireValue{}, e
			}
		}
	}
	return wireValue{T: "error", ID: id, V: entries}, nil
}

var (
	keyDone      = engine.InternKey("done")
	keyLastIndex = engine.InternKey("lastIndex")
	keyValue     = engine.InternKey("value")
	errorKeys    = []engine.PropertyKey{engine.InternKey("name"), engine.InternKey("message"), engine.InternKey("stack"), engine.InternKey("cause")}
)

type wireEntry struct {
	Key   any
	Value wireValue
}

func (b *bridge) encodeKey(key engine.PropertyKey, cache map[engine.PropertyKey]any) any {
	if key.IsSymbol() {
		return b.encodeSymbol(key.Symbol())
	}
	if encoded, ok := cache[key]; ok {
		return encoded
	}
	var encoded any
	if s := key.ToJSString(b.rt.Realm()); s.IsWellFormed() {
		encoded = rawJSON(appendString(nil, s.GoString()))
	} else {
		encoded = encodeString(s)
	}
	if cache != nil {
		cache[key] = encoded
	}
	return encoded
}
func encodeString(s *engine.String) wireValue {
	if s.IsWellFormed() {
		return wireValue{T: "string", V: s.GoString()}
	}
	units := s.UTF16()
	out := make([]int, len(units))
	for i, n := range units {
		out[i] = int(n)
	}
	return wireValue{T: "string16", V: out}
}
func marshal(v any) string { return string(appendJSON(nil, v)) }

func wireBytes(w wireValue) ([]byte, error) {
	text, ok := w.V.(string)
	if !ok {
		return nil, wireError("invalid buffer data")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(text)
	if err != nil {
		return nil, wireError("invalid buffer data")
	}
	return data, nil
}

// flattenWire keeps JSON serialization depth independent of the guest graph depth.
func flattenWire(root wireValue) wireValue {
	nodes := []wireValue{}
	var flatten func(any) any
	flatten = func(value any) any {
		switch x := value.(type) {
		case wireValue:
			switch x.T {
			case "array", "object", "map", "set", "error", "date", "regexp", "buffer", "view":
				id := len(nodes)
				nodes = append(nodes, x)
				return wireValue{T: "node", ID: id}
			}
			return x
		case []wireValue:
			out := make([]any, len(x))
			for i, v := range x {
				out[i] = flatten(v)
			}
			return out
		case []wireEntry:
			out := make([]any, len(x))
			for i, v := range x {
				out[i] = []any{flatten(v.Key), flatten(v.Value)}
			}
			return out
		case [2]wireValue:
			return []any{flatten(x[0]), flatten(x[1])}
		case []any:
			out := make([]any, len(x))
			for i, v := range x {
				out[i] = flatten(v)
			}
			return out
		default:
			return value
		}
	}
	reference := flatten(root).(wireValue)
	for i := 0; i < len(nodes); i++ {
		value := flatten(nodes[i].V)
		nodes[i].V = value
	}
	if len(nodes) == 0 {
		return root
	}
	return wireValue{T: "graph", V: nodes, Root: &reference}
}

func (b *bridge) expandWire(w wireValue) (wireValue, error) {
	if w.T != "graph" {
		return w, nil
	}
	raw, ok := w.V.([]any)
	if !ok || w.Root == nil {
		return wireValue{}, wireError("invalid wire graph")
	}
	nodes := make([]wireValue, len(raw))
	for i, value := range raw {
		node, ok := value.(wireValue)
		if !ok {
			return wireValue{}, wireError("invalid graph node")
		}
		nodes[i] = node
	}
	const pending, expanding, expanded = 0, 1, 2
	state := make([]uint8, len(nodes))
	var expandNode func(int) (wireValue, error)
	var expand func(any) (any, error)
	expand = func(value any) (any, error) {
		switch x := value.(type) {
		case wireValue:
			if x.T != "node" {
				return x, nil
			}
			if x.ID < 0 || x.ID >= len(nodes) {
				return nil, wireError("invalid graph node reference")
			}
			return expandNode(x.ID)
		case []any:
			for i, item := range x {
				next, err := expand(item)
				if err != nil {
					return nil, err
				}
				x[i] = next
			}
		}
		return value, nil
	}
	expandNode = func(i int) (wireValue, error) {
		switch state[i] {
		case expanding:
			return wireValue{}, wireError("cyclic graph node reference")
		case expanded:
			return nodes[i], nil
		}
		state[i] = expanding
		value, err := expand(nodes[i].V)
		if err != nil {
			return wireValue{}, err
		}
		nodes[i].V = value
		state[i] = expanded
		return nodes[i], nil
	}
	if w.Root.T == "node" {
		if w.Root.ID < 0 || w.Root.ID >= len(nodes) {
			return wireValue{}, wireError("invalid graph root")
		}
		return expandNode(w.Root.ID)
	}
	return *w.Root, nil
}

var wireWellKnownSymbols = map[string]*engine.Symbol{
	"asyncIterator": engine.SymAsyncIterator, "hasInstance": engine.SymHasInstance, "isConcatSpreadable": engine.SymIsConcatSpreadable, "iterator": engine.SymIterator, "match": engine.SymMatch, "matchAll": engine.SymMatchAll, "replace": engine.SymReplace, "search": engine.SymSearch, "species": engine.SymSpecies, "split": engine.SymSplit, "toPrimitive": engine.SymToPrimitive, "toStringTag": engine.SymToStringTag, "unscopables": engine.SymUnscopables,
}

func (b *bridge) decodeSymbol(w wireValue) (moejs.Value, error) {
	if w.Kind == "wellKnown" {
		if symbol := wireWellKnownSymbols[w.Name]; symbol != nil {
			return engine.SymbolValue(symbol), nil
		}
		return moejs.Undefined(), wireError("unknown well-known symbol")
	}
	if w.Kind == "global" {
		key, err := b.rt.FromGo(w.Name)
		if err != nil {
			return moejs.Undefined(), err
		}
		return b.methodValue(b.constructors["Symbol"], "for", key)
	}
	if w.Kind != "local" || w.ID == 0 {
		return moejs.Undefined(), wireError("invalid symbol identity")
	}
	if symbol := b.hostSymbols[w.ID].Value(); symbol != nil {
		return engine.SymbolValue(symbol), nil
	}
	var description *engine.String
	if w.V != nil {
		raw, err := readWire(w.V)
		if err != nil {
			return moejs.Undefined(), err
		}
		value, err := b.decode(raw, false, 0)
		if err != nil {
			return moejs.Undefined(), err
		}
		if value.IsString() {
			description = value.AsString()
		} else if !value.IsUndefined() {
			return moejs.Undefined(), wireError("invalid symbol description")
		}
	}
	symbol := engine.NewSymbol(description)
	b.trackSymbol(w.ID, symbol)
	return engine.SymbolValue(symbol), nil
}

var wireWellKnownNames = func() map[*engine.Symbol]string {
	names := make(map[*engine.Symbol]string, len(wireWellKnownSymbols))
	for name, symbol := range wireWellKnownSymbols {
		names[symbol] = name
	}
	return names
}()

func (b *bridge) encodeSymbol(symbol *engine.Symbol) wireValue {
	if name, ok := wireWellKnownNames[symbol]; ok {
		return wireValue{T: "symbol", Kind: "wellKnown", Name: name}
	}
	id := b.symbolHostIDs[weak.Make(symbol)]
	if id != 0 {
		return b.localSymbol(symbol, id)
	}
	value := engine.SymbolValue(symbol)
	if key, err := b.methodValue(b.constructors["Symbol"], "keyFor", value); err == nil && key.IsString() {
		return wireValue{T: "symbol", Kind: "global", Name: key.AsString().GoString()}
	}
	b.nextSymbolID++
	id = -b.nextSymbolID
	b.trackSymbol(id, symbol)
	return b.localSymbol(symbol, id)
}

func (b *bridge) localSymbol(symbol *engine.Symbol, id int) wireValue {
	description := wireValue{T: "undefined"}
	if symbol.Description() != nil {
		description = encodeString(symbol.Description())
	}
	return wireValue{T: "symbol", Kind: "local", ID: id, V: description}
}

type flatGraph struct {
	nodes      []wireValue
	containers []bool
	values     []moejs.Value
	state      []uint8
	deferred   map[int]int
	active     int
}

const (
	nodeResolving = 1
	nodeResolved  = 2
)

// Sizing containers from their entries, or plain NewObject, measured slower.
func (b *bridge) newContainer(t string) (moejs.Value, error) {
	switch t {
	case "array":
		return engine.ObjectValue(b.rt.Realm().NewArrayCap(0)), nil
	case "object":
		return engine.ObjectValue(b.rt.Realm().NewObjectCap(0)), nil
	case "map":
		return b.constructValue("Map")
	case "set":
		return b.constructValue("Set")
	}
	return b.constructValue("Error")
}

func (b *bridge) decodeFlatGraph(w wireValue, functions bool) (moejs.Value, error) {
	raw, ok := w.V.([]any)
	if !ok || w.Root == nil {
		return moejs.Undefined(), wireError("invalid wire graph")
	}
	g := &flatGraph{nodes: make([]wireValue, len(raw)), containers: make([]bool, len(raw)), values: make([]moejs.Value, len(raw)), state: make([]uint8, len(raw))}
	d := &wireDecoder{b: b, functions: functions, seen: make(map[int]moejs.Value), graph: g}
	for i, item := range raw {
		node, err := readWire(item)
		if err != nil {
			return moejs.Undefined(), err
		}
		g.nodes[i] = node
		switch node.T {
		case "array", "object", "map", "set", "error":
			if node.ID <= 0 {
				return moejs.Undefined(), wireError("graph container has no identity")
			}
			g.containers[i] = true
			if d.seen[node.ID], err = b.newContainer(node.T); err != nil {
				return moejs.Undefined(), err
			}
		case "date", "regexp", "buffer", "view":
			if node.ID > 0 {
				if g.deferred == nil {
					g.deferred = make(map[int]int)
				}
				g.deferred[node.ID] = i
			}
		}
	}
	for i, node := range g.nodes {
		var err error
		if g.containers[i] {
			_, err = d.value(node, 0)
		} else {
			_, err = d.resolve(i)
		}
		if err != nil {
			return moejs.Undefined(), err
		}
	}
	if w.Root.T == "node" {
		if w.Root.ID < 0 || w.Root.ID >= len(g.nodes) {
			return moejs.Undefined(), wireError("invalid graph root")
		}
		return d.resolve(w.Root.ID)
	}
	return d.value(*w.Root, 0)
}

func (d *wireDecoder) resolve(index int) (moejs.Value, error) {
	g := d.graph
	if g.containers[index] {
		return d.seen[g.nodes[index].ID], nil
	}
	switch g.state[index] {
	case nodeResolved:
		return g.values[index], nil
	case nodeResolving:
		return moejs.Undefined(), wireError("cyclic graph constructor dependency")
	}
	if g.active > 10000 {
		return moejs.Undefined(), wireError("cyclic graph constructor dependency")
	}
	g.state[index] = nodeResolving
	g.active++
	value, err := d.value(g.nodes[index], 0)
	g.active--
	if err != nil {
		return moejs.Undefined(), err
	}
	g.state[index] = nodeResolved
	g.values[index] = value
	return value, nil
}

func (b *bridge) encodeTree(v moejs.Value, seen map[*moejs.Object]int, depth int) (wireValue, error) {
	if err := b.nodeCheck(depth); err != nil {
		return wireValue{}, err
	}
	id, out, err := b.identify(v, seen)
	if id != 0 {
		out, err = b.encodeObject(v, id, func(child moejs.Value) (wireValue, error) { return b.encodeTree(child, seen, depth+1) }, nil)
	}
	if out.ID != 0 && out.T != "ref" && out.T != "native" && out.T != "symbol" && out.T != "function" {
		out.ID += 1 << 30
	}
	return out, err
}
