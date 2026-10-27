import { failure, type WireValue } from "./wire"
import type { Value, ValueScope } from "./value"

export type NativePrimitive =
  | "any"
  | "bool"
  | "string"
  | "int"
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "uint"
  | "uint8"
  | "uint16"
  | "uint32"
  | "uint64"
  | "float32"
  | "float64"
  | "Value"
  | "Object"
  | "String"
  | "Symbol"
  | "BigInt"
  | "PropertyKey"
  | "PropertyDescriptor"
  | "DecodeOptions"
  | "JSONOptions"
  | "time.Time"
  | "time.Location"
  | "json.RawMessage"
export interface NativeJSONCodec {
  Decode: (json: string) => unknown
  Encode?: (value: unknown) => string | Promise<string>
  Value?: unknown
}
export interface NativeTextCodec {
  Decode: (text: string) => unknown
  Encode?: (value: unknown) => string | Promise<string>
  Value?: unknown
}
export type NativeType =
  | NativePrimitive
  | "JSONCodec"
  | "TextCodec"
  | `engine.${string}`
  | `moejs.${string}`
  | { kind: "slice" | "pointer"; element: NativeType }
  | { kind: "array"; element: NativeType; length: number }
  | { kind: "map"; key: NativeType; value: NativeType }
  | { kind: "struct"; fields: NativeField[] }
export interface NativeField {
  name: string
  type: NativeType
  tag?: string
}
export const nativeTypes = {
  slice: (element: NativeType): NativeType => ({ kind: "slice", element }),
  pointer: (element: NativeType): NativeType => ({ kind: "pointer", element }),
  array: (element: NativeType, length: number): NativeType => ({ kind: "array", element, length }),
  map: (key: NativeType, value: NativeType): NativeType => ({ kind: "map", key, value }),
  struct: (fields: NativeField[]): NativeType => ({ kind: "struct", fields })
}
const states = new WeakMap<NativeHandle, { scope: ValueScope; released: boolean }>()
const handles = new WeakMap<ValueScope, Map<number, NativeHandle>>()

/** A real Go value owned by one runtime. Native handles are never implicitly guest values. */
export class NativeHandle {
  readonly id: number
  readonly kind: string
  readonly name: string
  constructor(scope: ValueScope, id: number, kind = "native", name = "") {
    this.id = id
    this.kind = kind
    states.set(this, { scope, released: false })
    this.name = name
  }
  private scope(): ValueScope {
    const state = states.get(this)!
    if (state.released) throw failure("bridge", "Native handle has been released")
    state.scope.assertUsable()
    return state.scope
  }
  private async operation<T>(op: string, payload: object = {}): Promise<T> {
    const scope = this.scope()
    return scope.decode(
      await scope.request<WireValue>(op, { native: scope.encode(this), ...payload })
    ) as T
  }
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const scope = this.scope()
    return this.operation("nativeInvoke", { method, nativeArgs: scope.encode(args) })
  }
  call<T = unknown>(...args: unknown[]): Promise<T> {
    const scope = this.scope()
    return this.operation("nativeCall", { nativeArgs: scope.encode(args) })
  }
  getField<T = unknown>(field: string): Promise<T> {
    return this.operation("nativeGetField", { field })
  }
  setField(field: string, value: unknown): Promise<void> {
    return this.operation("nativeSetField", { field, value: this.scope().encode(value) })
  }
  read<T = unknown>(): Promise<T> {
    return this.operation("nativeRead")
  }
  methods(): Promise<Record<string, string>> {
    return this.operation("nativeMethods")
  }
  asValue(): Promise<Value> {
    return this.operation("nativeAsValue")
  }
  async release(): Promise<void> {
    const state = states.get(this)!
    if (state.released) return
    await this.operation("nativeRelease")
    state.released = true
    handles.get(state.scope)?.delete(this.id)
  }
}
export function createNativeHandle(
  scope: ValueScope,
  ref: { id: number; kind?: string; name?: string; temporary?: boolean }
): NativeHandle {
  if (ref.temporary) return new NativeHandle(scope, ref.id, ref.kind, ref.name)
  let cache = handles.get(scope)
  if (!cache) handles.set(scope, (cache = new Map()))
  let handle = cache.get(ref.id)
  if (!handle) cache.set(ref.id, (handle = new NativeHandle(scope, ref.id, ref.kind, ref.name)))
  return handle
}
export function nativeWireReference(value: unknown, scope?: ValueScope): WireValue | undefined {
  if (!(value instanceof NativeHandle)) return undefined
  const state = states.get(value)!
  if (state.released) throw failure("bridge", "Native handle has been released")
  if (state.scope !== scope) throw failure("bridge", "Native handle belongs to another runtime")
  state.scope.assertUsable()
  return { t: "native", id: value.id, kind: value.kind }
}
export async function nativeRoot(
  scope: ValueScope,
  root: "runtime" | "realm" | "engine" | "moejs" = "runtime"
): Promise<NativeHandle> {
  return scope.decode(
    await scope.request<WireValue>("nativeRoot", { nativeRoot: root })
  ) as NativeHandle
}
export async function newNativeDecodeTarget(
  scope: ValueScope,
  type: NativeType,
  initial?: unknown
): Promise<NativeHandle> {
  return scope.decode(
    await scope.request<WireValue>("nativeTarget", {
      nativeType: type,
      ...(initial === undefined ? {} : { value: scope.encode(initial) })
    })
  ) as NativeHandle
}
