import { failure, type WireValue } from "./wire"
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
}
const states = new WeakMap<Value, { scope: ValueScope; released: boolean }>()
const handles = new WeakMap<ValueScope, Map<number, Value>>()

/** A rooted guest value. It is deliberately not thenable, including Promise handles. */
export class Value {
  readonly id: number
  readonly kind: string
  constructor(scope: ValueScope, id: number, kind = "value") {
    this.id = id
    this.kind = kind
    states.set(this, { scope, released: false })
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
  get(key: string): Promise<Value> {
    return this.operation("valueGet", { key, raw: true }) as Promise<Value>
  }
  async has(key: string): Promise<boolean> {
    const scope = this.scope()
    return scope.request("valueHas", { value: scope.encode(this), key })
  }
  export(): Promise<unknown> {
    return this.operation("valueExport")
  }
  call(thisValue: unknown, ...args: unknown[]): Promise<unknown> {
    const scope = this.scope()
    return this.operation("valueCall", {
      thisValue: scope.encode(thisValue),
      args: args.map((value) => scope.encode(value))
    })
  }
  callRaw(thisValue: unknown, ...args: unknown[]): Promise<Value> {
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
  appendJSONWith(prefix = "", options: JSONOptions = {}): Promise<string> {
    return this.appendJSON(prefix, options)
  }
  toGo(options: DecodeOptions = {}): Promise<unknown> {
    return this.operation("valueToGo", options)
  }
  toGoWith(options: DecodeOptions = {}): Promise<unknown> {
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
  private decodeInto(
    op: string,
    targetOrOptions: NativeHandle | DecodeOptions,
    options: DecodeOptions
  ): Promise<unknown> {
    const scope = this.scope()
    if ("id" in targetOrOptions)
      return this.operation(op, { ...options, nativeTarget: scope.encode(targetOrOptions) })
    return this.operation(op, targetOrOptions)
  }
  async release(): Promise<void> {
    const state = states.get(this)!
    if (state.released) return
    const scope = this.scope()
    await scope.request("valueRelease", { value: scope.encode(this) })
    state.released = true
    handles.get(scope)?.delete(this.id)
  }
}
export function createValue(scope: ValueScope, ref: { id: number; kind?: string }): Value {
  let cache = handles.get(scope)
  if (!cache) handles.set(scope, (cache = new Map()))
  let value = cache.get(ref.id)
  if (!value) cache.set(ref.id, (value = new Value(scope, ref.id, ref.kind)))
  return value
}
export function wireReference(value: unknown, scope?: ValueScope): WireValue | undefined {
  if (!(value instanceof Value)) return undefined
  const state = states.get(value)!
  if (state.released) throw failure("bridge", "Guest value has been released")
  if (state.scope !== scope) throw failure("bridge", "Guest value belongs to another runtime")
  state.scope.assertUsable()
  return { t: "ref", id: value.id, kind: value.kind }
}
