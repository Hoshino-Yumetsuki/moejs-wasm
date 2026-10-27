import { createValue, wireReference, type ValueScope } from "./value"
import { createNativeHandle, nativeWireReference } from "./native"

export type ErrorKind =
  | "syntax"
  | "exception"
  | "memory"
  | "interrupted"
  | "internal"
  | "bridge"
  | "host"
  | "closed"
  | "timeout"
  | "budget"

export interface ErrorPayload {
  kind: ErrorKind
  name: string
  message: string
  stack?: string
  file?: string
  line?: number
  column?: number
  value?: WireValue
  reason?: WireValue
  cause?: ErrorPayload
  code?: string
  path?: string
  valueKind?: string
  specifier?: string
  limit?: number
  allocated?: number
  live?: number
  omitted?: boolean
  object?: boolean
  target?: string
  field?: string
  offset?: number
}

export class MoeJSError extends Error {
  readonly kind: ErrorKind
  readonly file?: string
  readonly line?: number
  readonly column?: number
  readonly value?: unknown
  readonly reason?: unknown
  override readonly cause?: MoeJSError
  readonly code?: string
  readonly path?: string
  readonly valueKind?: string
  readonly specifier?: string
  readonly limit?: number
  readonly allocated?: number
  readonly live?: number
  readonly omitted?: boolean
  readonly object?: boolean
  readonly target?: string
  readonly field?: string
  readonly offset?: number

  constructor(error: ErrorPayload, scope?: ValueScope) {
    super(error.message)
    this.name = error.name
    this.kind = error.kind
    this.file = error.file
    this.line = error.line
    this.column = error.column
    this.value = error.value ? decode(error.value, scope) : undefined
    this.reason = error.reason ? decode(error.reason, scope) : undefined
    this.cause = error.cause ? new MoeJSError(error.cause, scope) : undefined
    this.code = error.code
    this.path = error.path
    this.valueKind = error.valueKind
    this.specifier = error.specifier
    this.limit = error.limit
    this.allocated = error.allocated
    this.live = error.live
    this.omitted = error.omitted
    this.object = error.object
    this.target = error.target
    this.field = error.field
    this.offset = error.offset
    if (error.stack) this.stack = error.stack
  }
}

export class TimeoutError extends MoeJSError {
  constructor(timeoutMs: number) {
    super({
      kind: "timeout",
      name: "TimeoutError",
      message: `MoeJS worker request exceeded ${timeoutMs}ms`
    })
  }
}

export function failure(kind: ErrorKind, message: string): MoeJSError {
  return new MoeJSError({ kind, name: "MoeJSError", message })
}

export function errorPayload(error: unknown, kind: ErrorKind = "host"): ErrorPayload {
  if (error instanceof MoeJSError) {
    return {
      kind: error.kind,
      name: error.name,
      message: error.message,
      stack: error.stack,
      file: error.file,
      line: error.line,
      column: error.column,
      code: error.code,
      path: error.path,
      valueKind: error.valueKind,
      specifier: error.specifier,
      limit: error.limit,
      allocated: error.allocated,
      live: error.live,
      omitted: error.omitted,
      object: error.object,
      target: error.target,
      field: error.field,
      offset: error.offset,
      cause: error.cause ? errorPayload(error.cause, kind) : undefined
    }
  }
  if (error instanceof Error) {
    return {
      kind,
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause !== undefined ? errorPayload(error.cause, kind) : undefined
    }
  }
  let message: string
  try {
    message = String(error)
  } catch {
    message = "Unprintable thrown value"
  }
  return { kind, name: "Error", message }
}

export type WireValue =
  | { t: "undefined" | "null" }
  | { t: "boolean"; v: boolean }
  | { t: "string"; v: string }
  | { t: "string16"; v: number[] }
  | { t: "number"; v: number | "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { t: "bigint"; v: string }
  | {
      t: "symbol"
      id: number
      kind: "local" | "global" | "wellKnown"
      name?: string
      v?: WireValue
    }
  | { t: "native"; id: number; kind?: string; name?: string; temporary?: boolean }
  | { t: "graph"; root: WireValue; v: WireValue[] }
  | { t: "node"; id: number }
  | { t: "array" | "set"; v: WireValue[]; id?: number }
  | { t: "object"; v: [string | WireValue, WireValue][]; id?: number }
  | { t: "map"; v: [WireValue, WireValue][]; id?: number }
  | { t: "date"; v: WireValue; id?: number }
  | { t: "regexp"; v: [WireValue, WireValue, WireValue]; id?: number }
  | { t: "error"; v: [string | WireValue, WireValue][]; id?: number }
  | { t: "buffer"; v: number[]; id?: number; kind?: string }
  | { t: "view"; v: WireValue; kind: string; offset: number; length: number; id?: number }
  | { t: "link"; id: number }
  | { t: "ref"; id: number; kind?: string }
  | { t: "function"; id: number; name?: string; length?: number; async?: boolean }

export type HostFunction = (...args: unknown[]) => unknown
export interface HostFunctionOptions {
  name?: string
  length?: number
  async?: boolean
}
const functionOptions = new WeakMap<HostFunction, HostFunctionOptions>()
export function defineHostFunction(
  fn: HostFunction,
  options: HostFunctionOptions = {}
): HostFunction {
  const wrapper: HostFunction = function (this: unknown, ...args) {
    return fn.apply(this, args)
  }
  functionOptions.set(wrapper, options)
  return wrapper
}

const hostSymbols = new Map<symbol, number>()
const symbolsByID = new Map<number, symbol>()
const wellKnownSymbols = new Map<symbol, string>(
  Object.getOwnPropertyNames(Symbol).flatMap((name) => {
    const value = Reflect.get(Symbol, name)
    return typeof value === "symbol" ? [[value, name] as [symbol, string]] : []
  })
)
const scopedSymbols = new WeakMap<ValueScope, Map<number, symbol>>()
const scopedSymbolWires = new WeakMap<ValueScope, Map<symbol, WireValue>>()
export function encode(
  value: unknown,
  register?: (fn: HostFunction) => number,
  scope?: ValueScope
): WireValue {
  const seen = new Map<object, number>()
  const pending: object[] = []
  const nodes: WireValue[] = []
  function visit(value: unknown): WireValue {
    const reference = wireReference(value, scope) ?? nativeWireReference(value, scope)
    if (reference) return reference
    if (value === undefined) return { t: "undefined" }
    if (value === null) return { t: "null" }
    switch (typeof value) {
      case "boolean":
        return { t: "boolean", v: value }
      case "string":
        return /[\uD800-\uDFFF]/u.test(value)
          ? {
              t: "string16",
              v: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))
            }
          : { t: "string", v: value }
      case "number":
        return {
          t: "number",
          v: Number.isNaN(value)
            ? "NaN"
            : value === Infinity
              ? "Infinity"
              : value === -Infinity
                ? "-Infinity"
                : Object.is(value, -0)
                  ? "-0"
                  : value
        }
      case "bigint":
        return { t: "bigint", v: String(value) }
      case "symbol": {
        const guestSymbol = scope ? scopedSymbolWires.get(scope)?.get(value) : undefined
        if (guestSymbol) return guestSymbol
        let id = hostSymbols.get(value)
        if (!id) {
          id = hostSymbols.size + 1
          hostSymbols.set(value, id)
          symbolsByID.set(id, value)
        }
        const known = wellKnownSymbols.get(value)
        const key = Symbol.keyFor(value)
        return {
          t: "symbol",
          id,
          kind: known ? "wellKnown" : key !== undefined ? "global" : "local",
          name: known ?? key,
          v: visit(value.description)
        }
      }
      case "function": {
        if (!register) throw failure("bridge", "Host function registration is unavailable")
        return {
          t: "function",
          id: register(value as HostFunction),
          ...functionOptions.get(value as HostFunction)
        }
      }
      case "object": {
        const previous = seen.get(value)
        if (previous) return { t: "link", id: previous }
        const id = seen.size + 1
        seen.set(value, id)
        pending.push(value)
        return { t: "node", id: id - 1 }
      }
      default:
        throw failure("bridge", `Unsupported host value: ${typeof value}`)
    }
  }
  function object(value: object, id: number): WireValue {
    if (Array.isArray(value)) return { t: "array", id, v: Array.from(value, visit) }
    if (value instanceof Date) return { t: "date", id, v: visit(value.getTime()) }
    if (value instanceof Map)
      return { t: "map", id, v: Array.from(value, ([key, item]) => [visit(key), visit(item)]) }
    if (value instanceof Set) return { t: "set", id, v: Array.from(value, visit) }
    if (value instanceof RegExp)
      return {
        t: "regexp",
        id,
        v: [visit(value.source), visit(value.flags), visit(value.lastIndex)]
      }
    if (
      value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
    )
      return {
        t: "buffer",
        id,
        kind: value instanceof ArrayBuffer ? "ArrayBuffer" : "SharedArrayBuffer",
        v: Array.from(new Uint8Array(value))
      }
    if (ArrayBuffer.isView(value)) {
      const length =
        value instanceof DataView
          ? value.byteLength
          : "length" in value && typeof value.length === "number"
            ? value.length
            : 0
      return {
        t: "view",
        id,
        kind:
          value instanceof DataView
            ? "DataView"
            : Object.prototype.toString.call(value).slice(8, -1),
        v: visit(value.buffer),
        offset: value.byteOffset,
        length
      }
    }
    if (value instanceof Error)
      return {
        t: "error",
        id,
        v: [...new Set(["name", "message", "stack", ...Object.getOwnPropertyNames(value)])].map(
          (key) => [visit(key), visit(Reflect.get(value, key))]
        )
      }
    return {
      t: "object",
      id,
      v: Reflect.ownKeys(value)
        .filter((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable)
        .map((key) => [visit(key), visit(Reflect.get(value, key))])
    }
  }
  const root = visit(value)
  for (let index = 0; index < pending.length; index++)
    nodes.push(object(pending[index]!, index + 1))
  return nodes.length ? { t: "graph", root, v: nodes } : root
}

const viewConstructors: Record<
  string,
  new (buffer: ArrayBuffer, offset: number, length: number) => ArrayBufferView
> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView
}
export function decode(value: WireValue, scope?: ValueScope): unknown {
  const seen = new Map<number, unknown>()
  let graph: WireValue[] = []
  const graphValues = new Map<number, unknown>()
  function visit(value: WireValue): unknown {
    switch (value.t) {
      case "graph": {
        graph = value.v
        for (let i = 0; i < graph.length; i++) {
          const node = graph[i]!
          if (["array", "object", "map", "set", "error"].includes(node.t))
            graphValues.set(i, visit({ ...node, v: [] } as WireValue))
        }
        for (let i = 0; i < graph.length; i++)
          if (!graphValues.has(i) && graph[i]!.t !== "view") graphValues.set(i, visit(graph[i]!))
        for (let i = 0; i < graph.length; i++)
          if (!graphValues.has(i)) graphValues.set(i, visit(graph[i]!))
        for (const node of graph)
          if (["array", "object", "map", "set", "error"].includes(node.t)) visit(node)
        return visit(value.root)
      }
      case "node":
        if (!graphValues.has(value.id)) {
          const node = graph[value.id]
          if (!node) throw failure("bridge", "Invalid graph node")
          graphValues.set(value.id, visit(node))
        }
        return graphValues.get(value.id)
      case "native":
        if (!scope) throw failure("bridge", "Native reference requires a runtime scope")
        return createNativeHandle(scope, value)
      case "symbol": {
        if (value.kind === "wellKnown") {
          const symbol = Reflect.get(Symbol, value.name ?? "")
          if (typeof symbol !== "symbol") throw failure("bridge", "Unknown well-known symbol")
          return symbol
        }
        if (value.kind === "global") return Symbol.for(value.name ?? "")
        if (value.id > 0 && symbolsByID.has(value.id)) return symbolsByID.get(value.id)
        let symbols = scope ? scopedSymbols.get(scope) : undefined
        if (!symbols && scope) scopedSymbols.set(scope, (symbols = new Map()))
        if (symbols?.has(value.id)) return symbols.get(value.id)
        const symbol = Symbol(value.v ? (visit(value.v) as string | undefined) : undefined)
        symbols?.set(value.id, symbol)
        if (scope) {
          let wires = scopedSymbolWires.get(scope)
          if (!wires) scopedSymbolWires.set(scope, (wires = new Map()))
          wires.set(symbol, value)
        }
        return symbol
      }
      case "undefined":
        return undefined
      case "null":
        return null
      case "boolean":
      case "string":
        return value.v
      case "string16": {
        let text = ""
        for (let offset = 0; offset < value.v.length; offset += 8192)
          text += String.fromCharCode(...value.v.slice(offset, offset + 8192))
        return text
      }
      case "number":
        return typeof value.v === "number" ? value.v : value.v === "-0" ? -0 : Number(value.v)
      case "bigint":
        return BigInt(value.v)
      case "ref":
        if (!scope) throw failure("bridge", "Guest reference requires a runtime scope")
        return createValue(scope, value)
      case "link":
        if (!seen.has(value.id)) throw failure("bridge", "Invalid graph reference")
        return seen.get(value.id)
      case "function":
        throw failure("bridge", "Unexpected host function in guest result")
      default: {
        let out: unknown
        switch (value.t) {
          case "array":
            out = []
            break
          case "object":
            out = {}
            break
          case "map":
            out = new Map()
            break
          case "set":
            out = new Set()
            break
          case "error":
            out = new Error()
            break
          case "date":
            out = new Date(visit(value.v) as number)
            break
          case "regexp":
            out = new RegExp(String(visit(value.v[0])), String(visit(value.v[1])))
            break
          case "buffer":
            if (value.kind === "SharedArrayBuffer") {
              if (typeof SharedArrayBuffer === "undefined")
                throw failure("bridge", "SharedArrayBuffer is unavailable in this host")
              const buffer = new SharedArrayBuffer(value.v.length)
              new Uint8Array(buffer).set(value.v)
              out = buffer
            } else out = Uint8Array.from(value.v).buffer
            break
          case "view": {
            const ctor = viewConstructors[value.kind]
            if (!ctor) throw failure("bridge", "Unsupported binary view " + value.kind)
            out = new ctor(visit(value.v) as ArrayBuffer, value.offset, value.length)
            break
          }
        }
        if (value.id && seen.has(value.id)) out = seen.get(value.id)
        if (value.id) seen.set(value.id, out)
        switch (value.t) {
          case "regexp":
            Reflect.set(out as object, "lastIndex", visit(value.v[2]))
            break
          case "array":
            for (const item of value.v) (out as unknown[]).push(visit(item))
            break
          case "object":
          case "error":
            for (const [key, item] of value.v)
              Object.defineProperty(
                out,
                typeof key === "string" ? key : (visit(key) as PropertyKey),
                {
                  value: visit(item),
                  writable: true,
                  configurable: true,
                  enumerable: true
                }
              )
            break
          case "map":
            for (const [key, item] of value.v)
              (out as Map<unknown, unknown>).set(visit(key), visit(item))
            break
          case "set":
            for (const item of value.v) (out as Set<unknown>).add(visit(item))
            break
        }
        return out
      }
    }
  }
  return visit(value)
}
