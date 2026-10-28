import { createValue, wireReference, type ValueScope } from "./value"
import { createNativeHandle, nativeWireReference } from "./native"
import { weakHandles } from "./handles"

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
  | "fatal"

export type ErrorCode =
  | "ERR_INTERRUPTED"
  | "ERR_INTERNAL"
  | "ERR_SYNTAX"
  | "ERR_TIMEOUT"
  | "ERR_MEMORY_LIMIT"
  | "ERR_EXECUTION_BUDGET"
  | "ERR_HOOK_NOT_FOUND"
  | "ERR_NOT_CALLABLE"
  | "ERR_FOREIGN"
  | "ERR_MODULE_PENDING"
  | "ERR_NO_RESOLVER"
  | "ERR_MODULE_RESOLVE"
  | "ERR_TOO_DEEP"
  | "ERR_DECODE_LIMIT"
  | "ERR_LOSSY_JSON"
  | "ERR_DECODE_TYPE"
  | "ERR_DECODE_TARGET"
  | "ERR_LOOP_TERMINATED"
  | "ERR_LOOP_RUNNING"

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
  hostId?: number
  reasonId?: number
}

// Host objects a layer came from, kept off the instance so it stays a plain record.
const origins = new WeakMap<MoeJSError, { hostId?: number; reasonId?: number; origin?: object }>()

export class MoeJSError extends Error {
  readonly kind: ErrorKind
  readonly file?: string
  readonly line?: number
  readonly column?: number
  readonly value?: unknown
  readonly reason?: unknown
  /** The next error layer; the host object itself when a host function threw it. */
  override readonly cause?: unknown
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
    const original = error.reasonId ? scope?.hostObject?.(error.reasonId) : undefined
    // Go counted the handles in the wires the host original replaces.
    if (original) scope?.discard?.([error.value, error.reason])
    this.value = original ?? (error.value ? decode(error.value, scope) : undefined)
    this.reason = original ?? (error.reason ? decode(error.reason, scope) : undefined)
    const thrown = error.cause?.hostId ? scope?.hostObject?.(error.cause.hostId) : undefined
    if (thrown) scope?.discard?.(error.cause)
    this.cause = thrown ?? (error.cause ? moeJSError(error.cause, scope) : undefined)
    if (error.hostId || error.reasonId)
      origins.set(this, {
        hostId: error.hostId,
        reasonId: error.reasonId,
        origin: error.hostId ? scope?.hostObject?.(error.hostId) : undefined
      })
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
    if (error.stack !== undefined) this.stack = error.stack
  }

  /** Like Go's errors.Is: matches a code or a host object on this error or any cause. */
  is(target: ErrorCode | (string & {}) | object): boolean {
    if (typeof target === "string" ? this.code === target : this === target) return true
    if (typeof target !== "string" && origins.get(this)?.origin === target) return true
    if (this.cause instanceof MoeJSError) return this.cause.is(target)
    return typeof target !== "string" && this.cause === target
  }
}

export class TimeoutError extends MoeJSError {
  constructor(timeoutMs: number) {
    super({
      kind: "timeout",
      name: "TimeoutError",
      message: `MoeJS worker request exceeded ${timeoutMs}ms`,
      code: "ERR_TIMEOUT"
    })
  }
}

/** Upstream MemoryLimitError: limit, allocated and live are always set; stack is "" when no JS ran. */
export class MemoryLimitError extends MoeJSError {
  declare readonly limit: number
  declare readonly allocated: number
  declare readonly live: number
}

export function moeJSError(error: ErrorPayload, scope?: ValueScope): MoeJSError {
  return error.name === "MemoryLimitError" && error.limit !== undefined
    ? new MemoryLimitError(error, scope)
    : new MoeJSError(error, scope)
}

export const sentinel = (code: ErrorCode, message: string) =>
  new MoeJSError({ kind: "bridge", name: "Error", message, code })
export const hookNotFound = () => sentinel("ERR_HOOK_NOT_FOUND", "moejs: hook not found")
export const notForeign = () =>
  sentinel("ERR_FOREIGN", "moejs: function or generator of another runtime")
export const loopRunning = () => sentinel("ERR_LOOP_RUNNING", "eventloop: loop is already running")
export function interruptMessage(reason: unknown): string {
  return reason === undefined ? "interrupted" : "interrupted: " + errorPayload(reason).message
}

export function failure(kind: ErrorKind, message: string): MoeJSError {
  return new MoeJSError({ kind, name: "MoeJSError", message })
}

export function errorPayload(
  error: unknown,
  kind: ErrorKind = "host",
  retain?: (value: object) => number
): ErrorPayload {
  if (error instanceof MoeJSError) {
    const { hostId, reasonId } = origins.get(error) ?? {}
    return {
      hostId,
      reasonId,
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
      cause: error.cause ? errorPayload(error.cause, kind, retain) : undefined
    }
  }
  if (error instanceof Error) {
    return {
      kind,
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause !== undefined ? errorPayload(error.cause, kind, retain) : undefined,
      hostId: retain?.(error)
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
  | { t: "buffer"; v: string; id?: number; kind?: string }
  | { t: "view"; v: WireValue; kind: string; offset: number; length: number; id?: number }
  | { t: "link"; id: number }
  | { t: "ref"; id?: number; kind?: string; v?: WireValue; temporary?: boolean }
  | { t: "rawjson"; v: string }
  | { t: "function"; id: number; name?: string; length?: number; async?: boolean; raw?: boolean }

export type HostFunction = (...args: unknown[]) => unknown
export interface HostFunctionOptions {
  name?: string
  length?: number
  async?: boolean
  /** NativeFunc arguments: call-scoped live Value handles instead of copies. */
  raw?: boolean
}

/** json.RawMessage: JSON text that upstream FromGo parses lazily and ToGo returns unread. */
export class RawMessage {
  readonly text: string
  constructor(text: string | Uint8Array) {
    this.text = typeof text === "string" ? text : new TextDecoder().decode(text)
  }
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

// Symbols are held weakly where the host allows it (ES2023): one neither side holds is recreated unobservably.
const weakSymbols = (() => {
  if (!weakHandles) return false
  try {
    new WeakRef(Symbol() as unknown as object)
    return true
  } catch {
    return false
  }
})()
class SymbolTable {
  private readonly refs = new Map<number, WeakRef<object> | symbol>()
  private readonly dropped = weakSymbols
    ? new FinalizationRegistry<number>((id) => {
        const ref = this.refs.get(id)
        if (ref instanceof WeakRef && ref.deref() === undefined) this.refs.delete(id)
      })
    : undefined
  get(id: number): symbol | undefined {
    const ref = this.refs.get(id)
    return (ref instanceof WeakRef ? ref.deref() : ref) as symbol | undefined
  }
  set(id: number, symbol: symbol): void {
    const key = symbol as unknown as object
    this.refs.set(id, this.dropped ? new WeakRef(key) : symbol)
    this.dropped?.register(key, id)
  }
}
function symbolMap<V>(): WeakMap<symbol, V> {
  return (weakSymbols ? new WeakMap() : new Map()) as unknown as WeakMap<symbol, V>
}
const hostSymbols = symbolMap<number>()
const symbolsByID = new SymbolTable()
let nextHostSymbol = 1
const wellKnownSymbols = new Map<symbol, string>(
  Object.getOwnPropertyNames(Symbol).flatMap((name) => {
    const value = Reflect.get(Symbol, name)
    return typeof value === "symbol" ? [[value, name] as [symbol, string]] : []
  })
)
const scopedSymbols = new WeakMap<ValueScope, SymbolTable>()
const scopedSymbolWires = new WeakMap<ValueScope, WeakMap<symbol, WireValue>>()
export function encode(
  value: unknown,
  register?: (fn: HostFunction) => number,
  scope?: ValueScope
): WireValue {
  const seen = new Map<object, number>()
  const pending: object[] = []
  const nodes: WireValue[] = []
  function visit(value: unknown): WireValue {
    if (value === undefined) return { t: "undefined" }
    if (value === null) return { t: "null" }
    switch (typeof value) {
      case "boolean":
        return { t: "boolean", v: value }
      case "string":
        return value.isWellFormed()
          ? { t: "string", v: value }
          : {
              t: "string16",
              v: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))
            }
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
        const known = wellKnownSymbols.get(value)
        const key = Symbol.keyFor(value)
        // Go finds well-known and registered symbols by name.
        let id = known || key !== undefined ? 0 : hostSymbols.get(value)
        if (id === undefined) {
          id = nextHostSymbol++
          hostSymbols.set(value, id)
          symbolsByID.set(id, value)
        }
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
        const reference = wireReference(value, scope) ?? nativeWireReference(value, scope)
        if (reference) return reference
        if (value instanceof RawMessage) return { t: "rawjson", v: value.text }
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
        v: toBase64(new Uint8Array(value))
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
          (key) => [visitKey(key), visit(Reflect.get(value, key))]
        )
      }
    const entries: [string | WireValue, WireValue][] = []
    for (const key of Object.keys(value))
      entries.push([visitKey(key), visit(Reflect.get(value, key))])
    for (const key of Object.getOwnPropertySymbols(value))
      if (Object.prototype.propertyIsEnumerable.call(value, key))
        entries.push([visit(key), visit(Reflect.get(value, key))])
    return { t: "object", id, v: entries }
  }
  function visitKey(key: string): string | WireValue {
    return key.isWellFormed() ? key : visit(key)
  }
  const root = visit(value)
  for (let index = 0; index < pending.length; index++)
    nodes.push(object(pending[index]!, index + 1))
  return nodes.length ? { t: "graph", root, v: nodes } : root
}

const nativeBase64 = Uint8Array as unknown as {
  fromBase64?: (text: string) => Uint8Array
  prototype: { toBase64?: () => string }
}
const NodeBuffer = (
  globalThis as {
    Buffer?: {
      from(
        buffer: ArrayBufferLike,
        offset: number,
        length: number
      ): { toString(encoding: string): string }
      from(text: string, encoding: string): Uint8Array
    }
  }
).Buffer
function toBase64(bytes: Uint8Array): string {
  if (nativeBase64.prototype.toBase64) return nativeBase64.prototype.toBase64.call(bytes)
  if (NodeBuffer)
    return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("base64")
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (nativeBase64.fromBase64) return nativeBase64.fromBase64(text) as Uint8Array<ArrayBuffer>
  if (NodeBuffer) {
    const view = NodeBuffer.from(text, "base64")
    // Node may pool small Buffers; copy into an exact, unshared ArrayBuffer.
    return new Uint8Array(view)
  }
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
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
const containerTags = new Set(["array", "object", "map", "set", "error"])

function decodeNumber(value: Extract<WireValue, { t: "number" }>["v"]): number {
  return typeof value === "number" ? value : value === "-0" ? -0 : Number(value)
}

export function decode(value: WireValue, scope?: ValueScope): unknown {
  switch (value.t) {
    case "undefined":
      return undefined
    case "null":
      return null
    case "boolean":
    case "string":
      return value.v
    case "number":
      return decodeNumber(value.v)
  }
  const seen = new Map<number, unknown>()
  let graph: WireValue[] = []
  let graphValues: unknown[] = []
  let resolved: boolean[] = []
  function resolve(index: number): unknown {
    if (!resolved[index]) {
      const node = graph[index]
      if (!node) throw failure("bridge", "Invalid graph node")
      graphValues[index] = visit(node)
      resolved[index] = true
    }
    return graphValues[index]
  }
  function visit(value: WireValue): unknown {
    switch (value.t) {
      case "graph": {
        graph = value.v
        graphValues = new Array(graph.length)
        resolved = new Array<boolean>(graph.length).fill(false)
        // Containers first so cycles can reach them, and buffers before their views.
        for (let i = 0; i < graph.length; i++) {
          const node = graph[i]!
          if (containerTags.has(node.t)) {
            graphValues[i] = container(node)
            resolved[i] = true
          }
        }
        for (let i = 0; i < graph.length; i++) if (graph[i]!.t !== "view") resolve(i)
        for (let i = 0; i < graph.length; i++) resolve(i)
        for (const node of graph) if (containerTags.has(node.t)) visit(node)
        return visit(value.root)
      }
      case "node":
        return resolve(value.id)
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
        const host = value.id > 0 ? symbolsByID.get(value.id) : undefined
        if (host) return host
        let symbols = scope ? scopedSymbols.get(scope) : undefined
        if (!symbols && scope) scopedSymbols.set(scope, (symbols = new SymbolTable()))
        const known = symbols?.get(value.id)
        if (known) return known
        const symbol = Symbol(value.v ? (visit(value.v) as string | undefined) : undefined)
        symbols?.set(value.id, symbol)
        if (scope) {
          let wires = scopedSymbolWires.get(scope)
          if (!wires) scopedSymbolWires.set(scope, (wires = symbolMap()))
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
        return decodeNumber(value.v)
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
      case "rawjson":
        return new RawMessage(value.v)
      default: {
        let out = value.id ? seen.get(value.id) : undefined
        if (out === undefined) {
          switch (value.t) {
            case "array":
            case "object":
            case "map":
            case "set":
            case "error":
              out = container(value)
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
                const bytes = fromBase64(value.v)
                const buffer = new SharedArrayBuffer(bytes.length)
                new Uint8Array(buffer).set(bytes)
                out = buffer
              } else out = fromBase64(value.v).buffer
              break
            case "view": {
              const ctor = viewConstructors[value.kind]
              if (!ctor) throw failure("bridge", "Unsupported binary view " + value.kind)
              out = new ctor(visit(value.v) as ArrayBuffer, value.offset, value.length)
              break
            }
          }
          if (value.id) seen.set(value.id, out)
        }
        switch (value.t) {
          case "regexp":
            Reflect.set(out as object, "lastIndex", visit(value.v[2]))
            break
          case "array":
            for (const item of value.v) (out as unknown[]).push(visit(item))
            break
          case "object":
            for (const [key, item] of value.v) {
              const name = typeof key === "string" ? key : (visit(key) as PropertyKey)
              const data = visit(item)
              // Assignment equals CreateDataProperty unless Object.prototype has the name.
              if (typeof name === "string" && !(name in Object.prototype))
                (out as Record<string, unknown>)[name] = data
              else defineData(out as object, name, data)
            }
            break
          case "error":
            for (const [key, item] of value.v)
              defineData(
                out as object,
                typeof key === "string" ? key : (visit(key) as PropertyKey),
                visit(item)
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
  function container(node: WireValue): unknown {
    const out =
      node.t === "array"
        ? []
        : node.t === "object"
          ? {}
          : node.t === "map"
            ? new Map()
            : node.t === "set"
              ? new Set()
              : new Error()
    if ("id" in node && node.id) seen.set(node.id, out)
    return out
  }
  return visit(value)
}

function defineData(target: object, key: PropertyKey, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true
  })
}
