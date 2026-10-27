import { afterEach, describe, expect, it } from "vitest"
import { createMoeJS, Value, type Engine } from "moejs-wasm"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})
async function setup() {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  const module = await engine.compile(
    "values.js",
    `
    export const echo = value => value
    export const retained = { count: 4, add(n) { return this.count + n } }
    export const promise = Promise.resolve(17)
    export const symbol = Symbol('kept')
    export async function callback(host) { return await host({ fn(n) { return this.base + n } }) }
    export async function nested(host) { const value = await host(); return await value.deep.fn(6) }
    export function jsonValue() { return { absent: undefined, nan: NaN, toJSON() { return { native: 9 } } } }
    export function sync(host) { return [host.name, host.length, host.call({ base: 40 }, 2)] }
    export const thrown = { reason: "original" }
    export function fail() { throw thrown }
    export function rethrow(host) { try { host() } catch (value) { return value === thrown } }
    export function symbolFacts(a, b, global, known, object) { return [a === b, global === Symbol.for('shared'), known === Symbol.iterator, object[a]] }
    export function sharedIncrement(buffer) { const view = new Int32Array(buffer); Atomics.add(view, 0, 2); return { buffer, view } }
    export function deep(n) { let value = { end: true }; while (n--) value = { next: value }; return value }
  `
  )
  const runtime = await engine.newRuntime()
  await runtime.load(module)
  return { engine, module, runtime }
}

describe("native WASM value bridge", () => {
  it("preserves resolver specifiers and typed host causes", async () => {
    const { engine } = await setup()
    const entry = await engine.compile(
      "missing-entry.js",
      "import { x } from 'missing'; export { x }"
    )
    await expect(
      engine.link(entry, () => {
        throw new TypeError("resolver denied")
      })
    ).rejects.toMatchObject({
      name: "ResolveError",
      file: "missing-entry.js",
      specifier: "missing",
      cause: { name: "TypeError", message: "resolver denied" }
    })
  }, 40_000)

  it("transfers symbol identity, registry entries, well-known keys and symbol properties", async () => {
    const { runtime, module } = await setup()
    const local = Symbol("local")
    expect(
      await runtime.call(
        module.hook("symbolFacts"),
        local,
        local,
        Symbol.for("shared"),
        Symbol.iterator,
        { [local]: 42 }
      )
    ).toEqual([true, true, true, 42])
    const value = { [local]: local, global: Symbol.for("shared"), known: Symbol.iterator }
    const result = await runtime.call<typeof value>(module.hook("echo"), value)
    expect(result[local]).toBe(local)
    expect(result.global).toBe(value.global)
    expect(result.known).toBe(Symbol.iterator)
    const raw = await runtime.getValue("symbol")
    const exported = await raw.export()
    expect(typeof exported).toBe("symbol")
    expect(await raw.export()).toBe(exported)
    await raw.release()
    expect(await runtime.call(module.hook("echo"), exported)).toBe(exported)
  }, 40_000)

  it("copies SharedArrayBuffer data while preserving shared kind and guest Atomics", async () => {
    const { runtime, module } = await setup()
    const input = new SharedArrayBuffer(8)
    new Int32Array(input)[0] = 40
    const output = await runtime.call<{ buffer: SharedArrayBuffer; view: Int32Array }>(
      module.hook("sharedIncrement"),
      input
    )
    expect(output.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(output.view.buffer).toBe(output.buffer)
    expect(output.view[0]).toBe(42)
    expect(new Int32Array(input)[0]).toBe(40)
  }, 40_000)

  it("imports class instance data without importing host prototypes", async () => {
    const { runtime, module } = await setup()
    class Record {
      value = 42
      nested = { label: "data" }
      method() {
        return this.value
      }
    }
    const input = new Record()
    const output = await runtime.call<Record>(module.hook("echo"), input)
    expect(output).toEqual({ value: 42, nested: { label: "data" } })
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
    expect("method" in output).toBe(false)
  }, 40_000)

  it("exports and imports graphs deeper than JSON nesting limits", async () => {
    const { runtime, module } = await setup()
    let result = await runtime.call<{ next?: unknown; end?: boolean }>(module.hook("deep"), 1500)
    const copied = await runtime.call<typeof result>(module.hook("echo"), result)
    let cursor = copied
    for (let index = 0; index < 1500; index++) cursor = cursor.next as typeof cursor
    expect(cursor.end).toBe(true)
    for (let index = 0; index < 1500; index++) result = result.next as typeof result
    expect(result.end).toBe(true)
  }, 40_000)

  it("exposes strict JSON paths and native loss metadata", async () => {
    const { runtime } = await setup()
    const value = await runtime.fromHost({ messages: [{ content: undefined }] })
    await expect(value.appendJSON("", { strict: true })).rejects.toMatchObject({
      name: "LossyJSONError",
      code: "ERR_LOSSY_JSON",
      path: "$.messages[0].content",
      valueKind: "undefined",
      omitted: true
    })
  }, 40_000)

  it("retains arbitrary interruption objects including cycles", async () => {
    const { runtime, module } = await setup()
    const reason: { code: string; self?: unknown } = { code: "paused" }
    reason.self = reason
    runtime.interrupt(reason)
    const error = (await runtime.call(module.hook("echo"), 1).catch((error: unknown) => error)) as {
      kind: string
      value: typeof reason
    }
    expect(error.kind).toBe("interrupted")
    expect(error.value.code).toBe("paused")
    expect(error.value.self).toBe(error.value)
    await runtime.clearInterrupt()
  }, 40_000)

  it("preserves binary view kinds, offsets, data and shared backing buffers", async () => {
    const { runtime, module } = await setup()
    const buffer = new ArrayBuffer(16)
    const bytes = new Uint8Array(buffer, 3, 5)
    bytes.set([0, 1, 127, 128, 255])
    const input = {
      bytes,
      view: new DataView(buffer, 2, 9),
      empty: new Uint8Array(buffer, 0, 0),
      emptyView: new DataView(buffer, 0, 0),
      buffer
    }
    const output = await runtime.call<typeof input>(module.hook("echo"), input)
    expect(output.bytes).toBeInstanceOf(Uint8Array)
    expect([...output.bytes]).toEqual([0, 1, 127, 128, 255])
    expect(output.bytes.byteOffset).toBe(3)
    expect(output.view).toBeInstanceOf(DataView)
    expect(output.view.byteLength).toBe(9)
    expect(output.bytes.buffer).toBe(output.buffer)
    expect(output.view.buffer).toBe(output.buffer)
    expect(output.empty.length).toBe(0)
    expect(output.emptyView.byteLength).toBe(0)
    expect(output.empty.buffer).toBe(output.buffer)
    expect(output.emptyView.buffer).toBe(output.buffer)
    const wide = new BigInt64Array([1n, -123456789012345n])
    expect(await runtime.call(module.hook("echo"), wide)).toEqual(wide)
  }, 40_000)

  it("preserves rich types and graph cycles instead of invoking JSON", async () => {
    const { runtime, module } = await setup()
    const key = { name: "shared" }
    const map = new Map<unknown, unknown>()
    map.set(key, key)
    map.set(map, map)
    const input = {
      map,
      set: new Set([key]),
      date: new Date(1700000000123),
      invalid: new Date(NaN),
      regexp: /a+b/giu,
      error: new TypeError("native error", { cause: key }),
      key,
      self: undefined as unknown
    }
    input.self = input
    input.regexp.lastIndex = 8
    const output = await runtime.call<typeof input>(module.hook("echo"), input)
    expect(output.self).toBe(output)
    expect(output.map.get(output.key)).toBe(output.key)
    expect(output.map.get(output.map)).toBe(output.map)
    expect(output.set.has(output.key)).toBe(true)
    expect(output.date.getTime()).toBe(input.date.getTime())
    expect(Number.isNaN(output.invalid.getTime())).toBe(true)
    expect(output.regexp.source).toBe("a+b")
    expect(output.regexp.flags).toBe("giu")
    expect(output.regexp.lastIndex).toBe(8)
    expect(output.error).toBeInstanceOf(Error)
    expect(output.error.name).toBe("TypeError")
    expect(output.error.cause).toBe(output.key)
  }, 40_000)

  it("retains stable raw refs, binds this, rejects foreign/released values and leaves promises raw", async () => {
    const { engine, runtime } = await setup()
    const object = await runtime.getValue("retained")
    expect(object).toBeInstanceOf(Value)
    expect(await runtime.getValue("retained")).toBe(object)
    const fn = await object.get("add")
    expect(await runtime.callFunction(fn, object, 3)).toBe(7)
    expect(await fn.call({ count: 10 }, 2)).toBe(12)
    expect(await object.has("count")).toBe(true)
    expect(await object.has("missing")).toBe(false)
    const promise = await runtime.getValue("promise")
    expect(promise).toBeInstanceOf(Value)
    expect(promise.kind).toBe("Promise")
    expect(await promise.export()).toBe(promise)
    const symbol = await runtime.getValue("symbol")
    expect(await runtime.getValue("symbol")).toBe(symbol)
    expect(await symbol.toGo()).toBe(symbol)
    await symbol.release()
    expect(await runtime.getValue("symbol")).not.toBe(symbol)
    const foreign = await engine.newRuntime()
    await expect(foreign.fromHost(object)).rejects.toThrow(/another runtime/)
    await object.release()
    await expect(object.export()).rejects.toThrow(/released/)
    await expect(runtime.fromHost(object)).rejects.toThrow(/released/)
  }, 40_000)

  it("uses native JSON semantics, strictness, parsing and exact native decode limits", async () => {
    const { runtime, module } = await setup()
    const value = await runtime.callValue(module.hook("jsonValue"))
    expect(await value.appendJSON("prefix:")).toBe('prefix:{"native":9}')
    const lossy = await runtime.fromHost({ absent: undefined, number: NaN })
    expect(await lossy.appendJSON()).toBe('{"number":null}')
    await expect(lossy.appendJSONWith("", { strict: true })).rejects.toThrow()
    const parsed = await runtime.parseJSONString('{"n":[1,2],"text":"é"}')
    expect(await parsed.unmarshalWith({ maxNodes: 5 })).toEqual({ n: [1, 2], text: "é" })
    await expect(parsed.unmarshalWith({ maxNodes: 4 })).rejects.toThrow(/too large|limit/i)
    await expect(parsed.toGoWith({ maxBytes: 5 })).rejects.toThrow(/too large|limit/i)
    const exact = await runtime.parseJSON(new TextEncoder().encode("[1,2]"))
    expect(await exact.toGoIntoWith({ maxBytes: 5, maxNodes: 3 })).toEqual([1, 2])
    await expect(exact.toGoIntoWith({ maxBytes: 4 })).rejects.toThrow(/too large|limit/i)
    const native = await runtime.fromHost({ missing: undefined, number: -0 })
    expect(await native.unmarshal()).toEqual({ number: 0 })
    const converted = await native.toGo()
    expect(converted).toEqual({ missing: null, number: -0 })
    const text = { ["\ud800"]: "\ud800\udc00\ud800" }
    expect(await runtime.call(module.hook("echo"), text)).toEqual(text)
    await expect(runtime.parseJSONString('{"bad":}')).rejects.toThrow()
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    await expect((await runtime.fromHost(cycle)).appendJSON()).rejects.toThrow()
  }, 40_000)

  it("registers nested host callbacks and invokes guest callbacks with explicit this", async () => {
    const { runtime, module } = await setup()
    expect(
      await runtime.call(module.hook("nested"), () => ({
        deep: { fn: (n: unknown) => Number(n) * 7 }
      }))
    ).toBe(42)
    expect(
      await runtime.call(module.hook("callback"), async (arg: unknown) => {
        if (!arg || typeof arg !== "object" || !("fn" in arg) || !(arg.fn instanceof Value))
          throw new Error("missing guest function")
        return runtime.callFunction(arg.fn, { base: 12 }, 5)
      })
    ).toBe(17)
  }, 40_000)

  it("preserves synchronous host metadata, receivers and rethrown guest exceptions", async () => {
    const { runtime, module } = await setup()
    const sum = runtime.function("sum", 1, function (this: { base: number }, value) {
      return this.base + Number(value)
    })
    expect(await runtime.call(module.hook("sync"), sum)).toEqual(["sum", 1, 42])
    const fail = await runtime.getValue("fail")
    const thrown = await runtime.getValue("thrown")
    await expect(fail.call(undefined)).rejects.toMatchObject({ kind: "exception", value: thrown })
    const rethrow = runtime.function("rethrow", 0, () => fail.call(undefined))
    expect(await runtime.call(module.hook("rethrow"), rethrow)).toBe(true)
  }, 40_000)
})
