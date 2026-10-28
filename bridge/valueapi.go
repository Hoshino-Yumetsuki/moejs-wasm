//go:build js && wasm

package main

import (
	"encoding/base64"
	"math"
	"reflect"
	"strings"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/engine"
)

type valueDescriptor struct {
	Value        *wireValue `json:"value"`
	Get          *wireValue `json:"get"`
	Set          *wireValue `json:"set"`
	Writable     *bool      `json:"writable"`
	Enumerable   *bool      `json:"enumerable"`
	Configurable *bool      `json:"configurable"`
}

// payloadKey is the operand's property key; strings that JSON would corrupt travel as wire values.
func (b *bridge) payloadKey(p *payload) (engine.PropertyKey, error) {
	r := b.rt.Realm()
	if p.KeyValue.T == "" {
		return r.KeyFromGoString(p.Key), nil
	}
	v, err := b.decodePlain(p.KeyValue)
	if err != nil {
		return engine.PropertyKey{}, err
	}
	if v.IsObject() {
		return engine.PropertyKey{}, wireError("property key must be a string, number or symbol")
	}
	return r.ToPropertyKey(v)
}

// decodePlain decodes only what cannot run guest code: references and primitives.
func (b *bridge) decodePlain(w wireValue) (moejs.Value, error) {
	switch w.T {
	case "ref", "undefined", "null", "boolean", "string", "string16", "number", "bigint", "symbol":
		return b.decode(w, false, 0)
	}
	return moejs.Undefined(), wireError("expected a guest value or primitive")
}

func objectFor(v moejs.Value, method string) (*engine.Object, error) {
	if !v.IsObject() {
		return nil, wireError(method + " requires an object")
	}
	return v.AsObject(), nil
}

func (b *bridge) leaf(v moejs.Value) operationResult {
	w, _ := b.encodeLeaf(v)
	return operationResult{data: w}
}

func (b *bridge) keyList(keys []engine.PropertyKey) operationResult {
	out := make([]any, len(keys))
	cache := make(map[engine.PropertyKey]any)
	for i, k := range keys {
		out[i] = b.encodeKey(k, cache)
	}
	return operationResult{data: out}
}

func rawValue(v moejs.Value) operationResult {
	return operationResult{value: v, hasValue: true, raw: true}
}

func (b *bridge) optionalObject(o *engine.Object) operationResult {
	if o == nil {
		return operationResult{}
	}
	return rawValue(engine.ObjectValue(o))
}

func (b *bridge) operands(p *payload, pure bool) ([]moejs.Value, error) {
	values := make([]moejs.Value, len(p.Args))
	for i, w := range p.Args {
		var err error
		if pure {
			values[i], err = b.decodePlain(w)
		} else {
			values[i], err = b.decode(w, true, 0)
		}
		if err != nil {
			return nil, err
		}
	}
	return values, nil
}

func (b *bridge) descriptor(d *valueDescriptor) (engine.PropertyDescriptor, error) {
	var desc engine.PropertyDescriptor
	if d == nil {
		return desc, nil
	}
	r := b.rt.Realm()
	if d.Value != nil {
		v, err := b.decode(*d.Value, true, 0)
		if err != nil {
			return desc, err
		}
		desc.SetValue(v)
	}
	for _, accessor := range []struct {
		w      *wireValue
		setter bool
	}{{d.Get, false}, {d.Set, true}} {
		if accessor.w == nil {
			continue
		}
		v, err := b.decode(*accessor.w, true, 0)
		if err != nil {
			return desc, err
		}
		if err := r.CheckAccessorFunction(v, accessor.setter); err != nil {
			return desc, err
		}
		if accessor.setter {
			desc.SetSet(v)
		} else {
			desc.SetGet(v)
		}
	}
	if d.Writable != nil {
		desc.SetWritable(*d.Writable)
	}
	if d.Enumerable != nil {
		desc.SetEnumerable(*d.Enumerable)
	}
	if d.Configurable != nil {
		desc.SetConfigurable(*d.Configurable)
	}
	if desc.IsAccessorDescriptor() && desc.IsDataDescriptor() {
		return desc, wireError("descriptor cannot contain both data and accessor fields")
	}
	return desc, nil
}

func (b *bridge) encodeDescriptor(desc engine.PropertyDescriptor) map[string]any {
	out := map[string]any{}
	accessor := func(v moejs.Value) wireValue {
		if v.IsObject() {
			return b.retainValue(v)
		}
		return wireValue{T: "undefined"}
	}
	if desc.HasValue() {
		out["value"] = b.retainValue(desc.Value)
	}
	if desc.HasGet() {
		out["get"] = accessor(desc.Get)
	}
	if desc.HasSet() {
		out["set"] = accessor(desc.Set)
	}
	if desc.HasWritable() {
		out["writable"] = desc.Writable()
	}
	if desc.HasEnumerable() {
		out["enumerable"] = desc.Enumerable()
	}
	if desc.HasConfigurable() {
		out["configurable"] = desc.Configurable()
	}
	return out
}

// fromGoValue is Runtime.FromGo of the host value, built as the Go value ToGo would give back.
func (b *bridge) fromGoValue(p *payload) (operationResult, error) {
	c, w, err := b.nativeConversion(p.Value)
	if err != nil {
		return operationResult{}, err
	}
	c.fromGo = true
	gv, err := c.convert(w, reflect.TypeFor[any](), 0)
	if err != nil {
		return operationResult{}, err
	}
	var x any
	if gv.IsValid() {
		x = gv.Interface()
	}
	v, err := b.rt.FromGo(x)
	return rawValue(v), err
}

func uint32Arg(args []moejs.Value, i int) (uint32, error) {
	if len(args) <= i || !args[i].IsNumber() {
		return 0, wireError("length must be a uint32")
	}
	n := args[i].AsNumber()
	if n < 0 || n > math.MaxUint32 || n != math.Trunc(n) {
		return 0, wireError("length must be a uint32")
	}
	return uint32(n), nil
}

func stringArg(args []moejs.Value, i int) (*engine.String, error) {
	if len(args) <= i || !args[i].IsString() {
		return nil, wireError("expected a string argument")
	}
	return args[i].AsString(), nil
}

// valuePure runs upstream methods that run no JavaScript, so they work while an interrupt is pending.
func (b *bridge) valuePure(p *payload) (operationResult, error) {
	r := b.rt.Realm()
	args, err := b.operands(p, true)
	if err != nil {
		return operationResult{}, err
	}
	switch p.Method {
	case "NewObject":
		return rawValue(engine.ObjectValue(r.NewObject())), nil
	case "NewObjectWithProto":
		var proto *engine.Object
		if len(args) != 0 && args[0].IsObject() {
			proto = args[0].AsObject()
		}
		return rawValue(engine.ObjectValue(r.NewObjectWithProto(proto))), nil
	case "NewArrayLen":
		n, err := uint32Arg(args, 0)
		if err != nil {
			return operationResult{}, err
		}
		return rawValue(engine.ObjectValue(r.NewArrayLen(n))), nil
	case "Global":
		return rawValue(engine.ObjectValue(r.Global)), nil
	case "Intrinsic":
		o, err := intrinsic(r, p.Name)
		if err != nil {
			return operationResult{}, err
		}
		return b.optionalObject(o), nil
	case "StringToBigInt":
		s, err := stringArg(args, 0)
		if err != nil {
			return operationResult{}, err
		}
		n, ok := engine.StringToBigInt(s)
		if !ok {
			return operationResult{}, nil
		}
		return b.leaf(engine.BigIntValue(n)), nil
	case "DetachArrayBuffer":
		if len(args) == 0 {
			return operationResult{}, wireError("DetachArrayBuffer requires a value")
		}
		return operationResult{}, r.DetachArrayBuffer(args[0])
	}
	if p.Value.T == "" {
		return operationResult{}, wireError(p.Method + " requires a value")
	}
	v, err := b.decodePlain(p.Value)
	if err != nil {
		return operationResult{}, err
	}
	switch p.Method {
	case "IsCallable":
		return operationResult{data: engine.IsCallable(v)}, nil
	case "IsConstructor":
		return operationResult{data: engine.IsConstructor(v)}, nil
	case "String":
		return operationResult{data: encodeString(engine.FromGoString(v.String()))}, nil
	case "DisplayString":
		return operationResult{data: encodeString(engine.FromGoString(r.DisplayString(v)))}, nil
	case "TypeOf":
		return operationResult{data: engine.TypeOf(v).GoString()}, nil
	case "ToBoolean":
		return operationResult{data: engine.ToBoolean(v)}, nil
	case "IsArray":
		ok, err := r.IsArray(v)
		return operationResult{data: ok}, err
	}
	o, err := objectFor(v, p.Method)
	if err != nil {
		return operationResult{}, err
	}
	switch p.Method {
	case "GetOwnProperty", "Delete", "HasProperty":
		key, err := b.payloadKey(p)
		if err != nil {
			return operationResult{}, err
		}
		switch p.Method {
		case "Delete":
			return operationResult{data: o.Delete(r, key)}, nil
		case "HasProperty":
			return operationResult{data: o.HasProperty(key)}, nil
		}
		desc, ok := o.GetOwnProperty(key)
		if !ok {
			return operationResult{}, nil
		}
		return operationResult{data: b.encodeDescriptor(desc)}, nil
	case "OwnPropertyKeys":
		return b.keyList(o.OwnPropertyKeys()), nil
	case "OwnEnumerableStringKeys":
		return b.keyList(o.OwnEnumerableStringKeys()), nil
	case "Proto":
		return b.optionalObject(o.Proto()), nil
	case "SetPrototypeOf":
		var proto *engine.Object
		if len(args) != 0 && args[0].IsObject() {
			proto = args[0].AsObject()
		}
		return operationResult{data: o.SetPrototypeOf(r, proto)}, nil
	case "PreventExtensions":
		o.PreventExtensions(r)
		return operationResult{}, nil
	case "Seal":
		o.Seal(r)
		return operationResult{}, nil
	case "Freeze":
		o.Freeze(r)
		return operationResult{}, nil
	case "IsExtensible":
		return operationResult{data: o.IsExtensible()}, nil
	case "IsFrozen":
		return operationResult{data: o.IsFrozen()}, nil
	case "IsSealed":
		return operationResult{data: o.IsSealed()}, nil
	case "Class":
		return operationResult{data: className(o.Class())}, nil
	case "IsRevokedProxy":
		return operationResult{data: o.IsRevokedProxy()}, nil
	case "IsModuleNamespace":
		return operationResult{data: o.IsModuleNamespace()}, nil
	case "PrimitiveValue":
		pv, ok := o.PrimitiveValue()
		w, _ := b.encodeLeaf(pv)
		return operationResult{data: map[string]any{"value": w, "ok": ok}}, nil
	case "ArrayLength":
		return operationResult{data: int64(o.ArrayLength())}, nil
	case "IsDetachedBuffer":
		return operationResult{data: o.IsDetachedBuffer()}, nil
	case "BufferData":
		data, ok := o.BufferData()
		if !ok {
			return operationResult{}, nil
		}
		return operationResult{data: wireValue{T: "buffer", Kind: "ArrayBuffer", V: base64Text(base64.StdEncoding.EncodeToString(data))}}, nil
	case "TypedArrayElements":
		elems, ok := o.TypedArrayElements()
		data, viewed := o.BufferData()
		kind := typedKind(elems)
		if !ok || !viewed || kind == "" {
			return operationResult{}, nil
		}
		buffer := wireValue{T: "buffer", Kind: "ArrayBuffer", V: base64Text(base64.StdEncoding.EncodeToString(data))}
		return operationResult{data: wireValue{T: "view", Kind: kind, Length: len(data) / elementSize(kind), V: buffer}}, nil
	case "RegExpData":
		d := o.RegExpData()
		if d == nil {
			return operationResult{}, nil
		}
		return operationResult{data: map[string]any{"source": encodeString(d.Source()), "flags": encodeString(d.Flags())}}, nil
	case "IteratorData":
		d, ok := o.Internal().(*engine.IteratorData)
		if !ok {
			return operationResult{}, nil
		}
		return operationResult{data: map[string]any{"target": b.retainValue(d.Target), "index": d.Index, "kind": iterKindName(d.Kind), "done": d.Done}}, nil
	}
	return operationResult{}, wireError("unknown value method " + p.Method)
}

// valueOp runs upstream methods that may run JavaScript, under the guard that drains their jobs.
func (b *bridge) valueOp(p *payload) (operationResult, error) {
	r := b.rt.Realm()
	args, err := b.operands(p, false)
	if err != nil {
		return operationResult{}, err
	}
	arg := func(i int) moejs.Value {
		if i < len(args) {
			return args[i]
		}
		return moejs.Undefined()
	}
	boolResult := func(ok bool, err error) (operationResult, error) { return operationResult{data: ok}, err }
	switch p.Method {
	case "NewArray":
		return rawValue(engine.ObjectValue(r.NewArray(args...))), nil
	case "NewRegExp":
		pattern, err := stringArg(args, 0)
		if err != nil {
			return operationResult{}, err
		}
		flags, err := stringArg(args, 1)
		if err != nil {
			return operationResult{}, err
		}
		rx, err := r.NewRegExp(pattern, flags)
		if err != nil {
			return operationResult{}, err
		}
		return rawValue(engine.ObjectValue(rx)), nil
	case "SameValue":
		return operationResult{data: engine.SameValue(arg(0), arg(1))}, nil
	case "SameValueZero":
		return operationResult{data: engine.SameValueZero(arg(0), arg(1))}, nil
	case "StrictEquals":
		return operationResult{data: engine.StrictEquals(arg(0), arg(1))}, nil
	case "LooseEquals":
		return boolResult(r.LooseEquals(arg(0), arg(1)))
	case "IsLessThan":
		n, err := r.IsLessThan(arg(0), arg(1), len(args) < 3 || engine.ToBoolean(args[2]))
		switch n {
		case engine.CompareTrue:
			return operationResult{data: true}, err
		case engine.CompareFalse:
			return operationResult{data: false}, err
		}
		return operationResult{}, err
	case "LessThan":
		return boolResult(r.LessThan(arg(0), arg(1)))
	case "GreaterThan":
		return boolResult(r.GreaterThan(arg(0), arg(1)))
	case "LessThanOrEqual":
		return boolResult(r.LessThanOrEqual(arg(0), arg(1)))
	case "GreaterThanOrEqual":
		return boolResult(r.GreaterThanOrEqual(arg(0), arg(1)))
	case "Add":
		v, err := r.Add(arg(0), arg(1))
		if err != nil {
			return operationResult{}, err
		}
		return b.leaf(v), nil
	case "InstanceOf":
		return boolResult(r.InstanceOf(arg(0), arg(1)))
	case "OrdinaryHasInstance":
		return boolResult(r.OrdinaryHasInstance(arg(0), arg(1)))
	case "FromGo":
		return b.fromGoValue(p)
	}
	if p.Value.T == "" {
		return operationResult{}, wireError(p.Method + " requires a value")
	}
	v, err := b.decode(p.Value, true, 0)
	if err != nil {
		return operationResult{}, err
	}
	switch p.Method {
	case "Construct":
		var newTarget *engine.Object
		if p.NewTarget.T != "" {
			nt, err := b.decode(p.NewTarget, true, 0)
			if err != nil {
				return operationResult{}, err
			}
			if !nt.IsObject() {
				return operationResult{}, wireError("newTarget must be an object")
			}
			newTarget = nt.AsObject()
		}
		result, err := r.Construct(v, args, newTarget)
		return rawValue(result), err
	case "ToPrimitive":
		hint := engine.HintDefault
		switch p.Hint {
		case "", "default":
		case "number":
			hint = engine.HintNumber
		case "string":
			hint = engine.HintString
		default:
			return operationResult{}, wireError("invalid ToPrimitive hint")
		}
		pv, err := r.ToPrimitive(v, hint)
		if err != nil {
			return operationResult{}, err
		}
		return b.leaf(pv), nil
	case "ToNumber", "ToIntegerOrInfinity":
		f := r.ToNumber
		if p.Method == "ToIntegerOrInfinity" {
			f = r.ToIntegerOrInfinity
		}
		n, err := f(v)
		return b.leaf(moejs.Number(n)), err
	case "ToNumeric":
		n, err := r.ToNumeric(v)
		return b.leaf(n), err
	case "ToString":
		s, err := r.ToString(v)
		if err != nil {
			return operationResult{}, err
		}
		return operationResult{data: encodeString(s)}, nil
	case "ToObject":
		o, err := r.ToObject(v)
		if err != nil {
			return operationResult{}, err
		}
		return rawValue(engine.ObjectValue(o)), nil
	case "ToInt32":
		n, err := r.ToInt32(v)
		return b.leaf(moejs.Number(float64(n))), err
	case "ToUint32":
		n, err := r.ToUint32(v)
		return b.leaf(moejs.Number(float64(n))), err
	case "ToLength", "ToIndex":
		f := r.ToLength
		if p.Method == "ToIndex" {
			f = r.ToIndex
		}
		n, err := f(v)
		return b.leaf(moejs.Number(float64(n))), err
	case "ToBigInt":
		n, err := r.ToBigInt(v)
		if err != nil {
			return operationResult{}, err
		}
		return b.leaf(engine.BigIntValue(n)), nil
	case "ToBigInt64":
		n, err := r.ToBigInt64(v)
		return b.leaf(engine.BigIntValue(engine.NewBigIntFromInt64(n))), err
	case "ToBigUint64":
		n, err := r.ToBigUint64(v)
		return b.leaf(engine.BigIntValue(engine.NewBigIntFromUint64(n))), err
	case "ToPropertyKey":
		key, err := r.ToPropertyKey(v)
		if err != nil {
			return operationResult{}, err
		}
		return operationResult{data: b.encodeKey(key, nil)}, nil
	case "GetMethod", "SetV":
		key, err := b.payloadKey(p)
		if err != nil {
			return operationResult{}, err
		}
		if p.Method == "SetV" {
			return operationResult{}, r.SetV(v, key, arg(0))
		}
		m, err := r.GetMethod(v, key)
		return rawValue(m), err
	}
	o, err := objectFor(v, p.Method)
	if err != nil {
		return operationResult{}, err
	}
	switch p.Method {
	case "OwnKeys", "EnumerableOwnKeys":
		f := r.OwnKeys
		if p.Method == "EnumerableOwnKeys" {
			f = r.EnumerableOwnKeys
		}
		keys, err := f(o)
		if err != nil {
			return operationResult{}, err
		}
		return b.keyList(keys), nil
	case "PrototypeOf":
		proto, err := r.PrototypeOf(o)
		if err != nil {
			return operationResult{}, err
		}
		return b.optionalObject(proto), nil
	case "Push":
		if o.Class() != engine.ClassArray {
			return operationResult{}, wireError("Push requires an array")
		}
		return operationResult{data: o.Push(r, args...)}, nil
	case "SetLength":
		if o.Class() != engine.ClassArray {
			return operationResult{}, wireError("SetLength requires an array")
		}
		n, err := uint32Arg(args, 0)
		if err != nil {
			return operationResult{}, err
		}
		return boolResult(o.SetLength(r, n))
	case "RegExpExec":
		if o.RegExpData() == nil {
			return operationResult{}, wireError("RegExpExec requires a RegExp")
		}
		s, err := stringArg(args, 0)
		if err != nil {
			return operationResult{}, err
		}
		result, err := r.RegExpExec(o, s)
		return rawValue(result), err
	case "IteratorNext":
		d, ok := o.Internal().(*engine.IteratorData)
		if !ok {
			return operationResult{}, wireError("IteratorNext requires an Array Iterator or String Iterator")
		}
		next, done, err := d.Next(r)
		if err != nil {
			return operationResult{}, err
		}
		return operationResult{data: map[string]any{"value": b.retainValue(next), "done": done}}, nil
	}
	key, err := b.payloadKey(p)
	if err != nil {
		return operationResult{}, err
	}
	switch p.Method {
	case "Lookup":
		value, found, err := o.Lookup(r, key)
		if err != nil {
			return operationResult{}, err
		}
		return operationResult{data: map[string]any{"value": b.retainValue(value), "found": found}}, nil
	case "Set":
		receiver := engine.ObjectValue(o)
		if p.Receiver.T != "" {
			if receiver, err = b.decode(p.Receiver, true, 0); err != nil {
				return operationResult{}, err
			}
		}
		return boolResult(o.Set(r, key, arg(0), receiver))
	case "SetProp":
		return operationResult{}, o.SetProp(r, key, arg(0))
	case "CreateDataProperty":
		return boolResult(o.CreateDataProperty(r, key, arg(0)))
	case "CreateDataPropertyOrThrow":
		return operationResult{}, o.CreateDataPropertyOrThrow(r, key, arg(0))
	case "DefineOwnProperty", "DefinePropertyOrThrow":
		desc, err := b.descriptor(p.Descriptor)
		if err != nil {
			return operationResult{}, err
		}
		if p.Method == "DefinePropertyOrThrow" {
			return operationResult{}, o.DefinePropertyOrThrow(r, key, desc)
		}
		return boolResult(o.DefineOwnProperty(r, key, desc))
	case "DeletePropertyOrThrow":
		return operationResult{}, o.DeletePropertyOrThrow(r, key)
	case "HasOwn":
		return boolResult(r.HasOwn(o, key))
	}
	return operationResult{}, wireError("unknown value method " + p.Method)
}

var classNames map[engine.Class]string

// className strips the Class prefix from the upstream constant name, read from the generated registry.
func className(c engine.Class) string {
	if classNames == nil {
		classNames = make(map[engine.Class]string)
		for name, value := range nativeRegistry_engine() {
			if class, ok := value.(engine.Class); ok && strings.HasPrefix(name, "Class") {
				classNames[class] = strings.TrimPrefix(name, "Class")
			}
		}
	}
	return classNames[c]
}

func iterKindName(k engine.IterKind) string {
	switch k {
	case engine.IterKeys:
		return "keys"
	case engine.IterEntries:
		return "entries"
	}
	return "values"
}

func typedKind(elems any) string {
	switch elems.(type) {
	case []int8:
		return "Int8Array"
	case []uint8:
		return "Uint8Array"
	case []int16:
		return "Int16Array"
	case []uint16:
		return "Uint16Array"
	case []int32:
		return "Int32Array"
	case []uint32:
		return "Uint32Array"
	case []float32:
		return "Float32Array"
	case []float64:
		return "Float64Array"
	case []int64:
		return "BigInt64Array"
	case []uint64:
		return "BigUint64Array"
	}
	return ""
}

func elementSize(kind string) int {
	switch kind {
	case "Int8Array", "Uint8Array":
		return 1
	case "Int16Array", "Uint16Array":
		return 2
	case "Int32Array", "Uint32Array", "Float32Array":
		return 4
	}
	return 8
}

func intrinsic(r *engine.Realm, name string) (*engine.Object, error) {
	switch name {
	case "ObjectPrototype":
		return r.ObjectPrototype, nil
	case "FunctionPrototype":
		return r.FunctionPrototype, nil
	case "ArrayPrototype":
		return r.ArrayPrototype, nil
	case "StringPrototype":
		return r.StringPrototype, nil
	case "NumberPrototype":
		return r.NumberPrototype, nil
	case "BooleanPrototype":
		return r.BooleanPrototype, nil
	case "ErrorPrototype":
		return r.ErrorPrototype, nil
	case "RegExpPrototype":
		return r.RegExpPrototype, nil
	case "DatePrototype":
		return r.DatePrototype, nil
	case "BigIntPrototype":
		return r.BigIntPrototype, nil
	case "ArrayIteratorPrototype":
		return r.ArrayIteratorPrototype, nil
	case "ObjectCtor":
		return r.ObjectCtor, nil
	case "FunctionCtor":
		return r.FunctionCtor, nil
	case "ArrayCtor":
		return r.ArrayCtor, nil
	case "StringCtor":
		return r.StringCtor, nil
	case "NumberCtor":
		return r.NumberCtor, nil
	case "BooleanCtor":
		return r.BooleanCtor, nil
	case "RegExpCtor":
		return r.RegExpCtor, nil
	case "DateCtor":
		return r.DateCtor, nil
	case "JSON":
		return r.JSON, nil
	case "Math":
		return r.Math, nil
	case "SymbolPrototype":
		return r.SymbolPrototype, nil
	case "SymbolCtor":
		return r.SymbolCtor, nil
	case "IteratorPrototype":
		return r.IteratorPrototype, nil
	case "StringIteratorPrototype":
		return r.StringIteratorPrototype, nil
	case "MapPrototype":
		return r.MapPrototype, nil
	case "MapCtor":
		return r.MapCtor, nil
	case "MapIteratorPrototype":
		return r.MapIteratorPrototype, nil
	case "SetPrototype":
		return r.SetPrototype, nil
	case "SetCtor":
		return r.SetCtor, nil
	case "SetIteratorPrototype":
		return r.SetIteratorPrototype, nil
	case "WeakMapPrototype":
		return r.WeakMapPrototype, nil
	case "WeakMapCtor":
		return r.WeakMapCtor, nil
	case "WeakSetPrototype":
		return r.WeakSetPrototype, nil
	case "WeakSetCtor":
		return r.WeakSetCtor, nil
	case "WeakRefPrototype":
		return r.WeakRefPrototype, nil
	case "WeakRefCtor":
		return r.WeakRefCtor, nil
	case "AggregateErrorPrototype":
		return r.AggregateErrorPrototype, nil
	case "AggregateErrorCtor":
		return r.AggregateErrorCtor, nil
	case "RegExpStringIteratorPrototype":
		return r.RegExpStringIteratorPrototype, nil
	}
	return nil, wireError("unknown intrinsic " + name)
}
