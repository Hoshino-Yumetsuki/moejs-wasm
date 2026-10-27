//go:build js && wasm

package main

import (
	"encoding/json"
	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/engine"
	"math"
	"strconv"
)

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
	Root      *wireValue `json:"root,omitempty"`
}

func wireError(message string) error { return &bridgeError{message} }

type bridgeError struct{ message string }

func (e *bridgeError) Error() string { return e.message }
func readWire(v any) (wireValue, error) {
	object, ok := v.(map[string]any)
	if !ok {
		return wireValue{}, wireError("invalid tagged wire value")
	}
	tag, ok := object["t"].(string)
	if !ok || tag == "" {
		return wireValue{}, wireError("wire value has no type")
	}
	id, _ := object["id"].(float64)
	length, _ := object["length"].(float64)
	offset, _ := object["offset"].(float64)
	kind, _ := object["kind"].(string)
	name, _ := object["name"].(string)
	var async *bool
	if a, ok := object["async"].(bool); ok {
		async = &a
	}
	out := wireValue{T: tag, V: object["v"], ID: int(id), Kind: kind, Offset: int(offset), Length: int(length), Name: name, Async: async}
	if raw, ok := object["root"]; ok {
		root, err := readWire(raw)
		if err != nil {
			return wireValue{}, err
		}
		out.Root = &root
	}
	return out, nil
}
func (b *bridge) decode(w wireValue, functions bool, depth int) (moejs.Value, error) {
	if w.T == "graph" {
		return b.decodeFlatGraph(w, functions)
	}
	return b.decodeGraph(w, functions, depth, make(map[int]moejs.Value))
}
func (b *bridge) decodeGraph(w wireValue, functions bool, depth int, seen map[int]moejs.Value) (moejs.Value, error) {
	if depth > 10000 {
		return moejs.Undefined(), wireError("wire value nesting exceeds 10000 levels")
	}
	child := func(v any) (moejs.Value, error) {
		x, e := readWire(v)
		if e != nil {
			return moejs.Undefined(), e
		}
		return b.decodeGraph(x, functions, depth+1, seen)
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
			return b.rt.FromGo(s)
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
		n, ok := engine.NewBigIntFromDecimal(s)
		if ok {
			return engine.BigIntValue(n), nil
		}
	case "ref":
		if v, ok := b.values[w.ID]; ok && w.ID > 0 {
			return v, nil
		}
		return moejs.Undefined(), wireError("unknown or released guest reference")
	case "link":
		if v, ok := seen[w.ID]; ok {
			return v, nil
		}
		return moejs.Undefined(), wireError("invalid graph reference")
	case "function":
		if !functions || w.ID <= 0 {
			return moejs.Undefined(), wireError("host function registration is unavailable")
		}
		opts := hostFunctionOptions{Name: w.Name, Length: w.Length, Async: true}
		if w.Async != nil {
			opts.Async = *w.Async
		}
		return b.hostFunction(w.ID, opts), nil
	case "symbol":
		return b.decodeSymbol(w)
	case "array", "object", "map", "set", "error":
		items, ok := w.V.([]any)
		if !ok {
			break
		}
		var value moejs.Value
		var err error
		switch w.T {
		case "array":
			value = engine.ObjectValue(r.NewArrayFromSlice(make([]moejs.Value, 0)))
		case "object":
			value = engine.ObjectValue(r.NewObject())
		case "map":
			value, err = b.constructValue("Map")
		case "set":
			value, err = b.constructValue("Set")
		case "error":
			value, err = b.constructValue("Error")
		}
		if err != nil {
			return moejs.Undefined(), err
		}
		if existing, ok := seen[w.ID]; ok {
			value = existing
		} else {
			remember(value)
		}
		for i, item := range items {
			if w.T == "array" {
				v, e := child(item)
				if e != nil {
					return moejs.Undefined(), e
				}
				if e = value.AsObject().CreateDataPropertyOrThrow(r, r.KeyFromGoString(strconv.Itoa(i)), v); e != nil {
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
		items, ok := w.V.([]any)
		if !ok {
			break
		}
		data := make([]byte, len(items))
		for i, x := range items {
			n, ok := x.(float64)
			if !ok || n < 0 || n > 255 || n != math.Trunc(n) {
				return moejs.Undefined(), wireError("invalid buffer byte")
			}
			data[i] = byte(n)
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
	}
	return moejs.Undefined(), wireError("invalid wire value of type " + w.T)
}
func (b *bridge) encode(v moejs.Value, seen map[*moejs.Object]bool, depth int) (wireValue, error) {
	type item struct {
		value moejs.Value
		depth int
	}
	queue := []item{{v, depth}}
	nodes := []wireValue{}
	identities := make(map[*moejs.Object]int)
	for index := 0; index < len(queue); index++ {
		current := queue[index]
		child := func(value moejs.Value) (wireValue, error) {
			index := len(queue)
			queue = append(queue, item{value, current.depth + 1})
			return wireValue{T: "node", ID: index}, nil
		}
		node, err := b.encodeNode(current.value, identities, current.depth, child)
		if err != nil {
			return wireValue{}, err
		}
		nodes = append(nodes, node)
	}
	if len(nodes) == 1 {
		return nodes[0], nil
	}
	root := wireValue{T: "node", ID: 0}
	return wireValue{T: "graph", V: nodes, Root: &root}, nil
}
func (b *bridge) encodeNode(v moejs.Value, seen map[*moejs.Object]int, depth int, child func(moejs.Value) (wireValue, error)) (wireValue, error) {
	if depth > 10000 {
		return wireValue{}, wireError("wire value nesting exceeds 10000 levels")
	}
	if err := b.rt.Realm().CheckInterrupt(); err != nil {
		return wireValue{}, err
	}
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
	default:
		return wireValue{}, wireError("unsupported guest primitive")
	}
	o := v.AsObject()
	class := o.Class()
	switch class {
	case engine.ClassObject, engine.ClassArray, engine.ClassMap, engine.ClassSet, engine.ClassDate, engine.ClassRegExp, engine.ClassError, engine.ClassArrayBuffer, engine.ClassSharedArrayBuffer, engine.ClassTypedArray, engine.ClassDataView:
	default:
		return b.retainValue(v), nil
	}
	if id := seen[o]; id != 0 {
		return wireValue{T: "link", ID: id}, nil
	}
	id := len(seen) + 1
	seen[o] = id
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
		bytes := make([]int, len(data))
		for i, x := range data {
			bytes[i] = int(x)
		}
		return wireValue{T: "buffer", ID: id, V: bytes, Kind: o.ClassName()}, nil
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
		length, e := b.rt.Get(v, "length")
		if e != nil {
			return wireValue{}, e
		}
		n := int(length.AsNumber())
		items := make([]wireValue, n)
		for i := range items {
			items[i], e = get(strconv.Itoa(i))
			if e != nil {
				return wireValue{}, e
			}
		}
		return wireValue{T: "array", ID: id, V: items}, nil
	case engine.ClassMap, engine.ClassSet:
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
		items := make([]any, 0)
		for {
			next, e := b.methodValue(iterator, "next")
			if e != nil {
				return wireValue{}, e
			}
			done, e := b.rt.Get(next, "done")
			if e != nil {
				return wireValue{}, e
			}
			if done.AsBool() {
				break
			}
			item, e := b.rt.Get(next, "value")
			if e != nil {
				return wireValue{}, e
			}
			if class == engine.ClassMap {
				key, e := b.rt.Get(item, "0")
				if e != nil {
					return wireValue{}, e
				}
				val, e := b.rt.Get(item, "1")
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
	keys, e := b.rt.Realm().EnumerableOwnKeys(o)
	if e != nil {
		return wireValue{}, e
	}
	for _, key := range o.OwnPropertyKeys() {
		if key.IsSymbol() {
			if desc, ok := o.GetOwnProperty(key); ok && desc.Enumerable() {
				keys = append(keys, key)
			}
		}
	}
	tag := "object"
	if class == engine.ClassError {
		tag = "error"
		for _, name := range []string{"name", "message", "stack", "cause"} {
			keys = append(keys, b.rt.Realm().KeyFromGoString(name))
		}
	}
	pairs := make([][2]any, 0, len(keys))
	used := make(map[engine.PropertyKey]bool)
	for _, key := range keys {
		if used[key] {
			continue
		}
		used[key] = true
		val, e := o.GetProp(b.rt.Realm(), key)
		if e != nil {
			return wireValue{}, e
		}
		item, e := child(val)
		if e != nil {
			return wireValue{}, e
		}
		var keyWire wireValue
		if key.IsSymbol() {
			keyWire = b.encodeSymbol(key.Symbol())
		} else {
			keyWire = encodeString(key.ToJSString(b.rt.Realm()))
		}
		pairs = append(pairs, [2]any{keyWire, item})
	}
	return wireValue{T: tag, ID: id, V: pairs}, nil
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
func marshal(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(data)
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
		case [][2]any:
			out := make([]any, len(x))
			for i, v := range x {
				out[i] = []any{flatten(v[0]), flatten(v[1])}
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
	nodes := make([]map[string]any, len(raw))
	for i, value := range raw {
		node, ok := value.(map[string]any)
		if !ok {
			return wireValue{}, wireError("invalid graph node")
		}
		nodes[i] = node
	}
	var expand func(any) (any, error)
	expand = func(value any) (any, error) {
		switch x := value.(type) {
		case map[string]any:
			if x["t"] == "node" {
				index, ok := x["id"].(float64)
				if !ok {
					index = 0
				}
				if index < 0 || index != math.Trunc(index) || int(index) >= len(nodes) {
					return nil, wireError("invalid graph node reference")
				}
				return nodes[int(index)], nil
			}
			return x, nil
		case []any:
			for i, item := range x {
				next, err := expand(item)
				if err != nil {
					return nil, err
				}
				x[i] = next
			}
			return x, nil
		default:
			return value, nil
		}
	}
	for _, node := range nodes {
		value, err := expand(node["v"])
		if err != nil {
			return wireValue{}, err
		}
		node["v"] = value
	}
	if w.Root.T == "node" {
		if w.Root.ID < 0 || w.Root.ID >= len(nodes) {
			return wireValue{}, wireError("invalid graph root")
		}
		return readWire(nodes[w.Root.ID])
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
	if symbol := b.hostSymbols[w.ID]; symbol != nil {
		return engine.SymbolValue(symbol), nil
	}
	if w.ID < 0 {
		return moejs.Undefined(), wireError("unknown guest symbol")
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
	b.hostSymbols[w.ID] = symbol
	b.symbolHostIDs[symbol] = w.ID
	return engine.SymbolValue(symbol), nil
}
func (b *bridge) encodeSymbol(symbol *engine.Symbol) wireValue {
	for name, known := range wireWellKnownSymbols {
		if symbol == known {
			return wireValue{T: "symbol", Kind: "wellKnown", Name: name}
		}
	}
	value := engine.SymbolValue(symbol)
	if key, err := b.methodValue(b.constructors["Symbol"], "keyFor", value); err == nil && key.IsString() {
		return wireValue{T: "symbol", Kind: "global", Name: key.AsString().GoString()}
	}
	id := b.symbolHostIDs[symbol]
	if id == 0 {
		b.nextSymbolID++
		id = -b.nextSymbolID
		b.hostSymbols[id] = symbol
		b.symbolHostIDs[symbol] = id
	}
	description := wireValue{T: "undefined"}
	if symbol.Description() != nil {
		description = encodeString(symbol.Description())
	}
	return wireValue{T: "symbol", Kind: "local", ID: id, V: description}
}

func (b *bridge) decodeFlatGraph(w wireValue, functions bool) (moejs.Value, error) {
	raw, ok := w.V.([]any)
	if !ok || w.Root == nil {
		return moejs.Undefined(), wireError("invalid wire graph")
	}
	nodes := make([]wireValue, len(raw))
	seen := make(map[int]moejs.Value)
	containers := make(map[int]bool)
	var deferred map[int]int
	for i, item := range raw {
		node, err := readWire(item)
		if err != nil {
			return moejs.Undefined(), err
		}
		nodes[i] = node
		switch node.T {
		case "array", "object", "map", "set", "error":
			if node.ID <= 0 {
				return moejs.Undefined(), wireError("graph container has no identity")
			}
			containers[i] = true
			empty := node
			empty.V = []any{}
			if _, err = b.decodeGraph(empty, functions, 0, seen); err != nil {
				return moejs.Undefined(), err
			}
		case "date", "regexp", "buffer", "view":
			if node.ID > 0 {
				if deferred == nil {
					deferred = make(map[int]int)
				}
				deferred[node.ID] = i
			}
		}
	}
	active := make(map[int]bool)
	var resolve func(int) (moejs.Value, error)
	var convert func(any) (any, error)
	convert = func(value any) (any, error) {
		switch x := value.(type) {
		case map[string]any:
			if x["t"] == "link" {
				number, _ := x["id"].(float64)
				id := int(number)
				if _, ready := seen[id]; !ready {
					if index, exists := deferred[id]; exists {
						if _, err := resolve(index); err != nil {
							return nil, err
						}
					}
				}
				return x, nil
			}
			if x["t"] != "node" {
				return x, nil
			}
			number, _ := x["id"].(float64)
			index := int(number)
			if number != float64(index) || index < 0 || index >= len(nodes) {
				return nil, wireError("invalid graph node")
			}
			id := -index - 1
			if containers[index] {
				id = nodes[index].ID
			} else {
				result, err := resolve(index)
				if err != nil {
					return nil, err
				}
				seen[id] = result
			}
			return map[string]any{"t": "link", "id": float64(id)}, nil
		case []any:
			out := make([]any, len(x))
			for i, item := range x {
				result, err := convert(item)
				if err != nil {
					return nil, err
				}
				out[i] = result
			}
			return out, nil
		default:
			return value, nil
		}
	}
	resolve = func(index int) (moejs.Value, error) {
		if containers[index] {
			return seen[nodes[index].ID], nil
		}
		if value, ok := seen[-index-1]; ok {
			return value, nil
		}
		if active[index] || len(active) > 10000 {
			return moejs.Undefined(), wireError("cyclic graph constructor dependency")
		}
		active[index] = true
		node := nodes[index]
		if node.T == "link" {
			if _, ready := seen[node.ID]; !ready {
				if target, exists := deferred[node.ID]; exists {
					if _, err := resolve(target); err != nil {
						return moejs.Undefined(), err
					}
				}
			}
		}
		data, err := convert(node.V)
		if err != nil {
			return moejs.Undefined(), err
		}
		node.V = data
		value, err := b.decodeGraph(node, functions, 0, seen)
		if err != nil {
			return moejs.Undefined(), err
		}
		delete(active, index)
		seen[-index-1] = value
		return value, nil
	}
	for i, node := range nodes {
		if !containers[i] {
			if _, err := resolve(i); err != nil {
				return moejs.Undefined(), err
			}
			continue
		}
		data, err := convert(node.V)
		if err != nil {
			return moejs.Undefined(), err
		}
		node.V = data
		if _, err = b.decodeGraph(node, functions, 0, seen); err != nil {
			return moejs.Undefined(), err
		}
	}
	if w.Root.T == "node" {
		if w.Root.ID < 0 || w.Root.ID >= len(nodes) {
			return moejs.Undefined(), wireError("invalid graph root")
		}
		return resolve(w.Root.ID)
	}
	return b.decodeGraph(*w.Root, functions, 0, seen)
}

func (b *bridge) encodeTree(v moejs.Value, seen map[*moejs.Object]int, depth int) (wireValue, error) {
	out, err := b.encodeNode(v, seen, depth, func(child moejs.Value) (wireValue, error) { return b.encodeTree(child, seen, depth+1) })
	if out.ID != 0 && out.T != "ref" && out.T != "native" && out.T != "symbol" && out.T != "function" {
		out.ID += 1 << 30
	}
	return out, err
}
