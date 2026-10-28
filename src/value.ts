import { failure, notForeign, type WireValue } from "./wire"
import { HandleCache, hostWire, type HandleState } from "./handles"
import type { NativeHandle } from "./native"

export interface DecodeOptions {
  maxBytes?: number
  maxNodes?: number
}
export interface JSONOptions {
  strict?: boolean
}
export interface ValueScope {
  request<T>(op: string, payload?: object): Promise<T>
  control?<T>(op: string, payload?: object): Promise<T>
  encode(value: unknown): WireValue
  decode(value: WireValue): unknown
  assertUsable(): void
  hostObject?(id: number): object | undefined
  /** Releases count posted occurrences of a Go handle; scripts and modules ignore count. */
  releaseHandle?(kind: "value" | "native" | "script" | "module", id: number, count: number): void
  /** Releases the handles in a Go message that will never be decoded. */
  discard?(data: unknown): void
}
export type ValueType =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "symbol"
  | "bigint"
  | "object"
/** An upstream engine.Class constant without its Class prefix. */
export type ObjectClass =
  | "Object"
  | "Array"
  | "Function"
  | "Error"
  | "Proxy"
  | "ArrayIterator"
  | "StringIterator"
  | (string & {})
export interface PropertyDescriptor<T = unknown> {
  value?: T
  get?: T
  set?: T
  writable?: boolean
  enumerable?: boolean
  configurable?: boolean
}
type Op = "valueOp" | "valuePure"
const states = new WeakMap<Value, HandleState>()
const handles = new HandleCache<Value>("value")
let collector: Value[] | undefined

function keyPayload(scope: ValueScope, key: PropertyKey): object {
  return typeof key === "string" && key.isWellFormed() ? { key } : { keyValue: scope.encode(key) }
}
function descriptorPayload(scope: ValueScope, desc: PropertyDescriptor): object {
  const out: Record<string, unknown> = {}
  for (const name of ["value", "get", "set"] as const)
    if (name in desc) out[name] = scope.encode(desc[name])
  for (const name of ["writable", "enumerable", "configurable"] as const)
    if (name in desc) out[name] = Boolean(desc[name])
  return { descriptor: out }
}
function keys(scope: ValueScope, list: (string | WireValue)[]): (string | symbol)[] {
  return list.map((key) => (typeof key === "string" ? key : (scope.decode(key) as string | symbol)))
}

/** A rooted guest value. It is deliberately not thenable, including Promise handles. */
export class Value {
  readonly id: number
  readonly kind: string
  constructor(scope: ValueScope, id: number, kind = "value", inline?: WireValue) {
    this.id = id
    this.kind = kind
    states.set(this, { scope, id, count: 0, released: false, inline })
  }
  /** engine.Value.Type: kind is ClassName() for objects and "object" for null. */
  get type(): ValueType {
    switch (this.kind) {
      case "undefined":
      case "boolean":
      case "number":
      case "string":
      case "symbol":
      case "bigint":
        return this.kind
      case "object":
        return "null"
    }
    return "object"
  }
  private scope(): ValueScope {
    const state = states.get(this)!
    if (state.released) throw failure("bridge", "Guest value has been released")
    state.scope.assertUsable()
    return state.scope
  }
  private async operation(op: string, payload: object = {}): Promise<unknown> {
    const scope = this.scope()
    return scope.decode(
      await scope.request<WireValue>(op, { value: scope.encode(this), ...payload })
    )
  }
  private async send<T>(op: Op, method: string, extra: object = {}): Promise<T> {
    const scope = this.scope()
    return scope.request<T>(op, { method, value: scope.encode(this), ...extra })
  }
  private async result<T>(op: Op, method: string, extra: object = {}): Promise<T> {
    const wire = await this.send<WireValue | null>(op, method, extra)
    return (wire === null ? wire : this.scope().decode(wire)) as T
  }
  private keyed(key: PropertyKey, extra: object = {}): object {
    return { ...keyPayload(this.scope(), key), ...extra }
  }
  private args(...values: unknown[]): object {
    const scope = this.scope()
    return { args: values.map((value) => scope.encode(value)) }
  }
  /** [[Get]]; a receiver runs getters and proxies with that this value. */
  async get(key: PropertyKey, options: { receiver?: unknown } = {}): Promise<Value> {
    const scope = this.scope()
    const receiver = "receiver" in options ? { receiver: scope.encode(options.receiver) } : {}
    return this.operation("valueGet", {
      ...keyPayload(scope, key),
      ...receiver,
      raw: true
    }) as Promise<Value>
  }
  /** The in operator (Realm.HasPropertyIn). */
  async has(key: PropertyKey): Promise<boolean> {
    const scope = this.scope()
    return scope.request("valueHas", { value: scope.encode(this), ...keyPayload(scope, key) })
  }
  async lookup(key: PropertyKey): Promise<{ value: Value; found: boolean }> {
    const result = await this.send<{ value: WireValue; found: boolean }>(
      "valueOp",
      "Lookup",
      this.keyed(key)
    )
    return { value: this.scope().decode(result.value) as Value, found: result.found }
  }
  async getMethod(key: PropertyKey): Promise<Value | undefined> {
    const method = await this.result<Value>("valueOp", "GetMethod", this.keyed(key))
    return method.type === "undefined" ? undefined : method
  }
  async set(
    key: PropertyKey,
    value: unknown,
    options: { receiver?: unknown } = {}
  ): Promise<boolean> {
    const receiver =
      "receiver" in options ? { receiver: this.scope().encode(options.receiver) } : {}
    return this.send("valueOp", "Set", this.keyed(key, { ...this.args(value), ...receiver }))
  }
  async setProp(key: PropertyKey, value: unknown): Promise<void> {
    await this.send("valueOp", "SetProp", this.keyed(key, this.args(value)))
  }
  async setV(key: PropertyKey, value: unknown): Promise<void> {
    await this.send("valueOp", "SetV", this.keyed(key, this.args(value)))
  }
  async createDataProperty(key: PropertyKey, value: unknown): Promise<boolean> {
    return this.send("valueOp", "CreateDataProperty", this.keyed(key, this.args(value)))
  }
  async createDataPropertyOrThrow(key: PropertyKey, value: unknown): Promise<void> {
    await this.send("valueOp", "CreateDataPropertyOrThrow", this.keyed(key, this.args(value)))
  }
  async defineOwnProperty(key: PropertyKey, desc: PropertyDescriptor): Promise<boolean> {
    return this.send(
      "valueOp",
      "DefineOwnProperty",
      this.keyed(key, descriptorPayload(this.scope(), desc))
    )
  }
  async definePropertyOrThrow(key: PropertyKey, desc: PropertyDescriptor): Promise<void> {
    await this.send(
      "valueOp",
      "DefinePropertyOrThrow",
      this.keyed(key, descriptorPayload(this.scope(), desc))
    )
  }
  /** Object.GetOwnProperty: no proxy trap; a proxy has no own properties. */
  async getOwnProperty(key: PropertyKey): Promise<PropertyDescriptor<Value> | undefined> {
    const desc = await this.send<Record<string, WireValue | boolean> | null>(
      "valuePure",
      "GetOwnProperty",
      this.keyed(key)
    )
    if (desc === null) return undefined
    const scope = this.scope()
    const out: PropertyDescriptor<Value> = {}
    for (const [name, field] of Object.entries(desc)) {
      if (typeof field === "boolean") out[name as "writable"] = field
      else {
        const decoded = scope.decode(field) as Value | undefined
        out[name as "value"] = decoded
      }
    }
    return out
  }
  /** Object.Delete: ordinary, so a proxy's deleteProperty trap does not run. */
  async delete(key: PropertyKey): Promise<boolean> {
    return this.send("valuePure", "Delete", this.keyed(key))
  }
  async deletePropertyOrThrow(key: PropertyKey): Promise<void> {
    await this.send("valueOp", "DeletePropertyOrThrow", this.keyed(key))
  }
  /** Object.HasProperty: ordinary, stopping at a proxy. */
  async hasProperty(key: PropertyKey): Promise<boolean> {
    return this.send("valuePure", "HasProperty", this.keyed(key))
  }
  async hasOwn(key: PropertyKey): Promise<boolean> {
    return this.send("valueOp", "HasOwn", this.keyed(key))
  }
  async ownKeys(): Promise<(string | symbol)[]> {
    return keys(this.scope(), await this.send("valueOp", "OwnKeys"))
  }
  async enumerableOwnKeys(): Promise<string[]> {
    return keys(this.scope(), await this.send("valueOp", "EnumerableOwnKeys")) as string[]
  }
  async ownPropertyKeys(): Promise<(string | symbol)[]> {
    return keys(this.scope(), await this.send("valuePure", "OwnPropertyKeys"))
  }
  async ownEnumerableStringKeys(): Promise<string[]> {
    return keys(this.scope(), await this.send("valuePure", "OwnEnumerableStringKeys")) as string[]
  }
  async proto(): Promise<Value | null> {
    return this.result("valuePure", "Proto")
  }
  async prototypeOf(): Promise<Value | null> {
    return this.result("valueOp", "PrototypeOf")
  }
  /** Ordinary [[SetPrototypeOf]]; false for non-extensible, shared and cyclic cases. */
  async setPrototypeOf(proto: Value | null): Promise<boolean> {
    if (proto !== null && !(proto instanceof Value))
      throw failure("bridge", "setPrototypeOf requires a Value or null")
    return this.send("valuePure", "SetPrototypeOf", this.args(proto))
  }
  async preventExtensions(): Promise<void> {
    await this.send("valuePure", "PreventExtensions")
  }
  async seal(): Promise<void> {
    await this.send("valuePure", "Seal")
  }
  async freeze(): Promise<void> {
    await this.send("valuePure", "Freeze")
  }
  async isExtensible(): Promise<boolean> {
    return this.send("valuePure", "IsExtensible")
  }
  async isFrozen(): Promise<boolean> {
    return this.send("valuePure", "IsFrozen")
  }
  async isSealed(): Promise<boolean> {
    return this.send("valuePure", "IsSealed")
  }
  async class(): Promise<ObjectClass> {
    return this.send("valuePure", "Class")
  }
  async isRevokedProxy(): Promise<boolean> {
    return this.send("valuePure", "IsRevokedProxy")
  }
  async isModuleNamespace(): Promise<boolean> {
    return this.send("valuePure", "IsModuleNamespace")
  }
  async primitiveValue(): Promise<{ value: unknown; ok: boolean }> {
    const result = await this.send<{ value: WireValue; ok: boolean }>("valuePure", "PrimitiveValue")
    return { value: this.scope().decode(result.value), ok: result.ok }
  }
  async isCallable(): Promise<boolean> {
    return this.send("valuePure", "IsCallable")
  }
  async isConstructor(): Promise<boolean> {
    return this.send("valuePure", "IsConstructor")
  }
  /** engine.Value.String: the debug form, which runs no code. */
  async string(): Promise<string> {
    return this.result("valuePure", "String")
  }
  async displayString(): Promise<string> {
    return this.result("valuePure", "DisplayString")
  }
  async typeOf(): Promise<string> {
    return this.send("valuePure", "TypeOf")
  }
  async toBoolean(): Promise<boolean> {
    return this.send("valuePure", "ToBoolean")
  }
  async construct(args: readonly unknown[] = [], newTarget?: Value): Promise<Value> {
    const extra = newTarget ? { newTarget: this.scope().encode(newTarget) } : {}
    return this.result("valueOp", "Construct", { ...this.args(...args), ...extra })
  }
  /** Realm.IsArray: follows proxies. */
  async isArray(): Promise<boolean> {
    return this.send("valuePure", "IsArray")
  }
  async arrayLength(): Promise<number> {
    return this.send("valuePure", "ArrayLength")
  }
  async push(...items: unknown[]): Promise<boolean> {
    return this.send("valueOp", "Push", this.args(...items))
  }
  async setLength(length: number): Promise<boolean> {
    return this.send("valueOp", "SetLength", this.args(length))
  }
  async isDetachedBuffer(): Promise<boolean> {
    return this.send("valuePure", "IsDetachedBuffer")
  }
  /** A copy of the bytes the buffer or view sees. */
  async bufferData(): Promise<Uint8Array | undefined> {
    const data = await this.result<ArrayBuffer | null>("valuePure", "BufferData")
    return data === null ? undefined : new Uint8Array(data)
  }
  /** A copy of the elements, typed as upstream: Uint8Clamped as Uint8, Float16 as its Uint16 bits. */
  async typedArrayElements(): Promise<ArrayBufferView | undefined> {
    return (
      (await this.result<ArrayBufferView | null>("valuePure", "TypedArrayElements")) ?? undefined
    )
  }
  async regExpExec(input: string): Promise<Value | null> {
    const result = await this.result<Value>("valueOp", "RegExpExec", this.args(input))
    return result.type === "null" ? null : result
  }
  async regExpData(): Promise<{ source: string; flags: string } | undefined> {
    const data = await this.send<{ source: WireValue; flags: WireValue } | null>(
      "valuePure",
      "RegExpData"
    )
    if (data === null) return undefined
    const scope = this.scope()
    return {
      source: scope.decode(data.source) as string,
      flags: scope.decode(data.flags) as string
    }
  }
  async toPrimitive(hint?: "default" | "number" | "string"): Promise<unknown> {
    return this.result("valueOp", "ToPrimitive", { hint: hint ?? "" })
  }
  async toNumber(): Promise<number> {
    return this.result("valueOp", "ToNumber")
  }
  async toNumeric(): Promise<number | bigint> {
    return this.result("valueOp", "ToNumeric")
  }
  /** Realm.ToString, named after PropertyKey.ToJSString so String(value) keeps working. */
  async toJSString(): Promise<string> {
    return this.result("valueOp", "ToString")
  }
  async toObject(): Promise<Value> {
    return this.result("valueOp", "ToObject")
  }
  async toIntegerOrInfinity(): Promise<number> {
    return this.result("valueOp", "ToIntegerOrInfinity")
  }
  toInt32(): Promise<number> {
    return this.result("valueOp", "ToInt32")
  }
  toUint32(): Promise<number> {
    return this.result("valueOp", "ToUint32")
  }
  async toLength(): Promise<number> {
    return this.result("valueOp", "ToLength")
  }
  async toIndex(): Promise<number> {
    return this.result("valueOp", "ToIndex")
  }
  async toBigInt(): Promise<bigint> {
    return this.result("valueOp", "ToBigInt")
  }
  toBigInt64(): Promise<bigint> {
    return this.result("valueOp", "ToBigInt64")
  }
  toBigUint64(): Promise<bigint> {
    return this.result("valueOp", "ToBigUint64")
  }
  async toPropertyKey(): Promise<string | symbol> {
    const key = await this.send<string | WireValue>("valueOp", "ToPropertyKey")
    return keys(this.scope(), [key])[0]!
  }
  /** IteratorData.Next of an Array or String Iterator, whatever its next method is. */
  async iteratorNext(): Promise<{ value: Value; done: boolean }> {
    const result = await this.send<{ value: WireValue; done: boolean }>("valueOp", "IteratorNext")
    return { value: this.scope().decode(result.value) as Value, done: result.done }
  }
  async iteratorData(): Promise<
    { target: Value; index: number; kind: "values" | "keys" | "entries"; done: boolean } | undefined
  > {
    const data = await this.send<{
      target: WireValue
      index: number
      kind: "values" | "keys" | "entries"
      done: boolean
    } | null>("valuePure", "IteratorData")
    if (data === null) return undefined
    return { ...data, target: this.scope().decode(data.target) as Value }
  }
  async export(): Promise<unknown> {
    // A handle that carries its primitive answers without a round trip.
    const inline = states.get(this)?.inline
    if (inline) return this.scope().decode(inline)
    return this.operation("valueExport")
  }
  async call(thisValue: unknown, ...args: unknown[]): Promise<unknown> {
    const scope = this.scope()
    return this.operation("valueCall", {
      thisValue: scope.encode(thisValue),
      args: args.map((value) => scope.encode(value))
    })
  }
  async callRaw(thisValue: unknown, ...args: unknown[]): Promise<Value> {
    const scope = this.scope()
    return this.operation("valueCall", {
      thisValue: scope.encode(thisValue),
      args: args.map((value) => scope.encode(value)),
      raw: true
    }) as Promise<Value>
  }
  async appendJSON(prefix = "", options: JSONOptions = {}): Promise<string> {
    const scope = this.scope()
    return scope.request("valueJSON", { value: scope.encode(this), prefix, ...options })
  }
  async appendJSONWith(prefix = "", options: JSONOptions = {}): Promise<string> {
    return this.appendJSON(prefix, options)
  }
  async toGo(options: DecodeOptions = {}): Promise<unknown> {
    const inline = states.get(this)?.inline
    if (inline) return this.scope().decode(inline)
    return this.operation("valueToGo", options)
  }
  async toGoWith(options: DecodeOptions = {}): Promise<unknown> {
    return this.toGo(options)
  }
  unmarshal(
    targetOrOptions: NativeHandle | DecodeOptions = {},
    options: DecodeOptions = {}
  ): Promise<unknown> {
    return this.decodeInto("valueUnmarshal", targetOrOptions, options)
  }
  unmarshalWith(
    targetOrOptions: NativeHandle | DecodeOptions = {},
    options: DecodeOptions = {}
  ): Promise<unknown> {
    return this.unmarshal(targetOrOptions, options)
  }
  toGoInto(
    targetOrOptions: NativeHandle | DecodeOptions = {},
    options: DecodeOptions = {}
  ): Promise<unknown> {
    return this.decodeInto("valueToGoInto", targetOrOptions, options)
  }
  toGoIntoWith(
    targetOrOptions: NativeHandle | DecodeOptions = {},
    options: DecodeOptions = {}
  ): Promise<unknown> {
    return this.toGoInto(targetOrOptions, options)
  }
  private async decodeInto(
    op: string,
    targetOrOptions: NativeHandle | DecodeOptions,
    options: DecodeOptions
  ): Promise<unknown> {
    const scope = this.scope()
    if (!("id" in targetOrOptions)) return this.operation(op, targetOrOptions)
    // Go fills the target in place, as upstream's UnmarshalWith does, and sends nothing back.
    await scope.request(op, {
      value: scope.encode(this),
      ...options,
      nativeTarget: scope.encode(targetOrOptions)
    })
    return targetOrOptions
  }
  /** Releases the handle now rather than once it is collected. */
  async release(): Promise<void> {
    const state = states.get(this)!
    if (state.released) return
    const scope = this.scope()
    state.released = true
    // Go frees a temporary when its call ends; an inline primitive holds nothing.
    if (state.inline || state.temporary) return
    handles.remove(this, state)
    await scope.request("valueRelease", {
      value: { t: "ref", id: this.id, kind: this.kind },
      count: state.count
    })
  }
}
export function createValue(
  scope: ValueScope,
  ref: { id?: number; kind?: string; v?: WireValue; temporary?: boolean }
): Value {
  // Primitives that do not allocate upstream carry their value and take no slot.
  if (ref.v !== undefined) return new Value(scope, 0, ref.kind, ref.v)
  if (ref.temporary) {
    const value = new Value(scope, ref.id!, ref.kind)
    states.get(value)!.temporary = true
    collector?.push(value)
    return value
  }
  // A wire the host built decodes to its own handle.
  const own = (ref as { [hostWire]?: Value })[hostWire]
  if (own) return own
  let value = handles.get(scope, ref.id!)
  if (!value) {
    value = new Value(scope, ref.id!, ref.kind)
    handles.add(scope, ref.id!, value, states.get(value)!)
  }
  states.get(value)!.count++
  return value
}
/** Runs fn, collecting the call-scoped Values its decodes create. */
export function collectTemporaries<T>(fn: () => T): [T, Value[]] {
  const previous = collector
  const collected: Value[] = []
  collector = collected
  try {
    return [fn(), collected]
  } finally {
    collector = previous
  }
}
export function expireValues(values: readonly Value[]): void {
  for (const value of values) states.get(value)!.released = true
}
export function wireReference(value: unknown, scope?: ValueScope): WireValue | undefined {
  if (!(value instanceof Value)) return undefined
  const state = states.get(value)!
  if (state.released) throw failure("bridge", "Guest value has been released")
  if (state.scope !== scope) throw notForeign()
  state.scope.assertUsable()
  return (
    state.inline ?? ({ t: "ref", id: value.id, kind: value.kind, [hostWire]: value } as WireValue)
  )
}
