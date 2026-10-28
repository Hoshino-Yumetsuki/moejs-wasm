import { afterEach, describe, expect, it } from "vitest"
import { createMoeJS, MoeJSError, type Engine } from "moejs-wasm"
import { nodeAdapter, type Adapter } from "moejs-wasm/node"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})
async function create() {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  engines.push(engine)
  return engine
}

describe("real MoeJS WASM runtimes", () => {
  it("compiles once at the API surface and isolates module and global state", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "plugin.js",
      `
      let count = 0
      export const hooks = { increment: (n) => ({ value: n + ++count, label: tenant }) }
      export function capabilities() {
        return [typeof process, typeof require,
          Object.isFrozen(Array.prototype), ({}).constructor.constructor("return typeof process")()]
      }
    `
    )
    const hook = mod.hook("hooks", "increment")
    const [a, b] = await Promise.all([engine.newRuntime(), engine.newRuntime()])
    await a.setGlobal("tenant", "a")
    await b.setGlobal("tenant", "b")
    await Promise.all([a.load(mod), b.load(mod)])
    expect(await a.call(hook, 10)).toEqual({ value: 11, label: "a" })
    expect(await a.call(hook, 10)).toEqual({ value: 12, label: "a" })
    expect(await b.call(hook, 10)).toEqual({ value: 11, label: "b" })
    expect(await a.call(mod.hook("capabilities"))).toEqual([
      "undefined",
      "undefined",
      true,
      "undefined"
    ])
    await a.close()
    await expect(a.call(hook, 1)).rejects.toMatchObject({ kind: "closed" })
    expect(await b.call(hook, 1)).toEqual({ value: 3, label: "b" })
  }, 30_000)

  it("preserves non-JSON primitives and does not pollute object prototypes", async () => {
    const engine = await create()
    const mod = await engine.compile("values.js", "export const echo = value => value")
    const rt = await engine.newRuntime()
    await rt.load(mod)
    const object = Object.fromEntries([
      ["__proto__", { safe: true }],
      ["missing", undefined]
    ])
    const value = [
      undefined,
      null,
      false,
      "",
      -0,
      NaN,
      Infinity,
      -Infinity,
      12345678901234567890n,
      object
    ]
    const result = await rt.call(mod.hook("echo"), value)
    expect(result).toEqual(value)
    expect(Object.is((result as unknown[])[4], -0)).toBe(true)
    expect(Object.getPrototypeOf((result as unknown[])[9])).toBe(Object.prototype)
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const returned = await rt.call<typeof cycle>(mod.hook("echo"), cycle)
    expect(returned.self).toBe(returned)
    expect(await rt.call(mod.hook("echo"), new Map([["key", 3]]))).toEqual(new Map([["key", 3]]))
  }, 30_000)

  it("awaits host callbacks, top-level await and guest promises; propagates errors", async () => {
    const engine = await create()
    const mod = await engine.compileTS(
      "host.ts",
      `
      const prefix: string = await host.prefix()
      host.loaded()
      export async function run(value: number): Promise<string> {
        return prefix + await host.double(value)
      }
      export async function recover() {
        try { await host.fail() } catch (error) { return error.message }
      }
      export async function reject() { throw new RangeError("guest rejection") }
    `
    )
    const rt = await engine.newRuntime()
    const done = Promise.withResolvers<void>()
    await rt.setGlobal("host", {
      prefix: async () => "answer:",
      loaded: () => done.resolve(),
      double: async (n: unknown) => Number(n) * 2,
      fail: () => {
        throw new Error("host denied")
      }
    })
    await expect(rt.load(mod)).rejects.toMatchObject({ code: "ERR_MODULE_PENDING" })
    await done.promise
    expect(await rt.call(mod.hook("run"), 21)).toBe("answer:42")
    expect(await rt.call(mod.hook("recover"))).toBe("host denied")
    await expect(rt.call(mod.hook("reject"))).rejects.toMatchObject({
      kind: "exception",
      name: "RangeError",
      message: "guest rejection"
    })
    expect(await rt.call(mod.hook("run"), 2)).toBe("answer:4")
  }, 30_000)

  it("runs classic scripts and preserves syntax and guest stack details", async () => {
    const engine = await create()
    await expect(engine.compile("broken.js", "export const =")).rejects.toMatchObject({
      kind: "syntax",
      file: "broken.js",
      line: 1
    })
    const rt = await engine.newRuntime({ disableDynamicCode: true })
    const script = await engine.compileScript(
      "state.js",
      "globalThis.counter = (globalThis.counter ?? 0) + 1; counter"
    )
    expect(await rt.runScript(script)).toBe(1)
    expect(await rt.runScript(script)).toBe(2)
    const mod = await engine.compile(
      "error.js",
      `
      export function fail() { throw new TypeError("guest failed") }
      export function dynamic() { return eval("1") }
      export const config = { enabled: true }
    `
    )
    await rt.load(mod)
    await expect(rt.call(mod.hook("fail"))).rejects.toMatchObject({
      kind: "exception",
      name: "TypeError",
      message: "guest failed",
      stack: expect.stringContaining("error.js")
    })
    await expect(rt.call(mod.hook("dynamic"))).rejects.toMatchObject({ name: "EvalError" })
    expect(await rt.get("config", "enabled")).toBe(true)
  }, 30_000)

  it("stops non-catchable CPU and memory exhaustion without blocking the host", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "limits.js",
      `
      export function spin() { try { for (;;) {} } catch (error) { return "escaped" } }
      export function allocate() { try { return new Array(1000000).fill("x") } catch (error) { return "escaped" } }
      export function ok() { return 42 }
    `
    )
    const rt = await engine.newRuntime({ maxSteps: 10_000 })
    await rt.load(mod)
    await expect(rt.call(mod.hook("spin"))).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "budget" }
    })
    const limited = await engine.newRuntime({ memoryLimit: 1_000_000 })
    await limited.load(mod)
    await expect(limited.call(mod.hook("allocate"))).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "memory" }
    })
    const fresh = await engine.newRuntime()
    await fresh.load(mod)
    expect(await fresh.call(mod.hook("ok"))).toBe(42)
  }, 30_000)

  it("gives each host promise settlement a fresh step budget", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "async-budget.js",
      `
      function burn() { let t = 0; for (let i = 0; i < 500; i++) t += i; return t }
      export async function ticks(n) { for (let i = 0; i < n; i++) { await host.tick(); burn() } return n }
      export async function runaway() { await host.tick(); for (;;) {} }
      export function burnAll(n) { for (let i = 0; i < n; i++) burn(); return n }
    `
    )
    const rt = await engine.newRuntime({ maxSteps: 10_000 })
    await rt.setGlobal("host", { tick: async () => null })
    await rt.load(mod)
    await expect(rt.call(mod.hook("burnAll"), 50)).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "budget" }
    })
    await rt.clearInterrupt()
    expect(await rt.call(mod.hook("ticks"), 50)).toBe(50)
    await expect(rt.call(mod.hook("runaway"))).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "budget" }
    })
  }, 30_000)

  it("treats maxSteps 0 or a negative value as no limit, like MemoryLimit", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "unbounded.js",
      `
      export function count(n) { let i = 0; while (i < n) i++; return i }
      export function allocate() { return new Array(1_000_000).fill("x").length }
    `
    )
    const limited = await engine.newRuntime()
    await limited.load(mod)
    await expect(limited.call(mod.hook("count"), 2_000_000)).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "budget" }
    })
    for (const maxSteps of [0, -1]) {
      const rt = await engine.newRuntime({ maxSteps, memoryLimit: -1 })
      await rt.load(mod)
      expect(await rt.call(mod.hook("count"), 2_000_000)).toBe(2_000_000)
      expect(await rt.call(mod.hook("allocate"))).toBe(1_000_000)
      expect((await rt.stats()).MemoryLimitHits).toBe(0)
    }
    await expect(engine.newRuntime({ maxSteps: Infinity })).rejects.toThrow(RangeError)
    await expect(engine.newRuntime({ maxSteps: 1.5 })).rejects.toThrow(RangeError)
  }, 30_000)

  it("stops a module whose evaluation runs out of steps instead of timing out", async () => {
    const engine = await create()
    const mod = await engine.compile("tiny.js", "export const answer = 42")
    for (const maxSteps of [1, 2, 3]) {
      const rt = await engine.newRuntime({ maxSteps })
      await expect(rt.load(mod)).rejects.toMatchObject({
        kind: "interrupted",
        cause: { kind: "budget" }
      })
    }
  }, 30_000)

  it("waits to measure call arguments as fromHost does, so oversized arguments stop the request", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "size.js",
      "export function size(items) { return items.length }"
    )
    const big = Array.from({ length: 100_000 }, (_, i) => ({ i }))
    const unlimited = await engine.newRuntime()
    const before = await unlimited.measureLive()
    const kept = await unlimited.fromHost(big)
    expect((await unlimited.measureLive([kept])) - before).toBeGreaterThan(1_500_000)
    await kept.release()
    const limited = await engine.newRuntime({ memoryLimit: 1_000_000 })
    await limited.load(mod)
    await expect(limited.call(mod.hook("size"), big)).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "memory" }
    })
    const copied = await engine.newRuntime({ memoryLimit: 1_000_000 })
    await expect(copied.fromHost(big)).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "memory" }
    })
    const small = await engine.newRuntime({ memoryLimit: 1_000_000 })
    await small.load(mod)
    expect(await small.call(mod.hook("size"), big.slice(0, 1_000))).toBe(1_000)
  }, 30_000)

  it("keeps the memory budget across reentrant SetGlobal calls", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "memory-reentry.js",
      `
      export function allocate() {
        const retained = []
        for (let i = 0; i < 60; i++) {
          retained.push(new Array(2000).fill(i))
          tick()
        }
        return retained.length
      }
    `
    )
    const runtime = await engine.newRuntime({ memoryLimit: 500_000 })
    await runtime.setGlobal(
      "tick",
      runtime.function("tick", 0, async () => {
        await runtime.setGlobal("stamp", 0)
      })
    )
    await runtime.load(mod)
    await expect(runtime.call(mod.hook("allocate"))).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "memory" }
    })
  }, 30_000)

  it("preserves host callback error cause chains through guest exceptions", async () => {
    const engine = await create()
    const mod = await engine.compile("host-error.js", "export function fail() { return host() }")
    const runtime = await engine.newRuntime()
    await runtime.setGlobal(
      "host",
      runtime.function("host", 0, () => {
        throw new Error("outer", { cause: new TypeError("inner") })
      })
    )
    await runtime.load(mod)
    await expect(runtime.call(mod.hook("fail"))).rejects.toMatchObject({
      kind: "exception",
      message: "outer",
      cause: { message: "outer", cause: { name: "TypeError", message: "inner" } }
    })
  }, 30_000)

  it.each([false, true])(
    "keeps host interruptions uncatchable (async: %s)",
    async (async) => {
      const engine = await create()
      const mod = await engine.compile(
        "host-interrupt.js",
        `
      export let caught = false
      export let continued = false
      export async function fail() {
        try { await host() } catch { caught = true }
        continued = true
      }
      export function state() { return [caught, continued] }
    `
      )
      const runtime = await engine.newRuntime()
      await runtime.setGlobal(
        "host",
        runtime.function(
          "host",
          0,
          () => {
            throw new MoeJSError({
              kind: "interrupted",
              name: "InterruptedError",
              message: "host cancelled execution",
              reason: { t: "object", v: [["token", { t: "number", v: 42 }]] }
            })
          },
          { async }
        )
      )
      await runtime.load(mod)
      await expect(runtime.call(mod.hook("fail"))).rejects.toMatchObject({
        kind: "interrupted",
        reason: { token: 42 }
      })
      await runtime.clearInterrupt()
      expect(await runtime.call(mod.hook("state"))).toEqual([false, false])
    },
    30_000
  )

  it("hands warm runtime endpoints to newRuntime and replaces them", async () => {
    await expect(createMoeJS({ warmRuntimes: -1 })).rejects.toThrow(RangeError)
    const engine = await createMoeJS({ timeoutMs: 10_000, warmRuntimes: 1 })
    engines.push(engine)
    const mod = await engine.compile("warm.js", "export const tenant = () => globalThis.tenant")
    const [a, b] = await Promise.all([engine.newRuntime(), engine.newRuntime()])
    await Promise.all([a.setGlobal("tenant", "a"), b.setGlobal("tenant", "b")])
    await Promise.all([a.load(mod), b.load(mod)])
    expect(await a.call(mod.hook("tenant"))).toBe("a")
    expect(await b.call(mod.hook("tenant"))).toBe("b")
    await a.close()
    const c = await engine.newRuntime()
    await c.load(mod)
    expect(await c.call(mod.hook("tenant"))).toBeUndefined()
  }, 30_000)

  it("replaces warm runtime endpoints that fail, but not endlessly", async () => {
    const native = nodeAdapter()
    let created = 0
    let failing = 1
    const adapter: Adapter = {
      loadModule: (url) => native.loadModule(url),
      createWorker(module, options, handlers) {
        // The first endpoint is the compiler.
        if (created++ > 0 && failing-- > 0) return Promise.reject(new Error("no worker"))
        return native.createWorker(module, options, handlers)
      }
    }
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const engine = await createMoeJS({ timeoutMs: 10_000, warmRuntimes: 1, adapter })
    engines.push(engine)
    await until(() => created === 3)
    expect(created).toBe(3)
    const runtime = await engine.newRuntime()
    expect(await runtime.evalScript("probe.js", "1 + 1")).toBe(2)

    created = 0
    failing = Infinity
    const broken = await createMoeJS({ timeoutMs: 10_000, warmRuntimes: 1, adapter })
    engines.push(broken)
    await until(() => created >= 3)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(created).toBe(3)
  }, 30_000)

  it("bounds pending promises and can close an outstanding call immediately", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "pending.js",
      "export function wait() { return new Promise(() => {}) }"
    )
    const rt = await engine.newRuntime({ timeoutMs: 1000 })
    await rt.load(mod)
    await expect(rt.call(mod.hook("wait"))).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "timeout" }
    })
    const other = await engine.newRuntime()
    await other.load(mod)
    const pending = other.call(mod.hook("wait"))
    const assertion = expect(pending).rejects.toMatchObject({ kind: "closed" })
    await other.close()
    await assertion
  }, 30_000)

  it("starts a new allocation budget after a top-level setGlobal and keeps the count when it fails", async () => {
    const engine = await create()
    const runtime = await engine.newRuntime({ memoryLimit: 5_000_000 })
    await runtime.setGlobal(
      "table",
      Array.from({ length: 2000 }, (_, i) => ({ i, label: `row ${i}` }))
    )
    expect((await runtime.stats()).RequestAllocatedBytes).toBe(0)
    await runtime.evalScript(
      "trap.js",
      'Object.defineProperty(globalThis, "trap", { set() { throw new Error("refused") } }); undefined'
    )
    await expect(
      runtime.setGlobal(
        "trap",
        Array.from({ length: 2000 }, (_, i) => i)
      )
    ).rejects.toMatchObject({ kind: "exception", message: "refused" })
    expect((await runtime.stats()).RequestAllocatedBytes).toBeGreaterThan(0)
  }, 30_000)

  it("rejects host bigints over the 2^20-bit BigInt limit", async () => {
    const engine = await create()
    const mod = await engine.compile("bigint.js", "export const kind = (n) => typeof n")
    const runtime = await engine.newRuntime()
    await runtime.load(mod)
    const tooBig = {
      kind: "exception",
      name: "RangeError",
      message: "Maximum BigInt size exceeded"
    }
    expect(await runtime.call(mod.hook("kind"), 1n << 1048575n)).toBe("bigint")
    await expect(runtime.fromHost(1n << 1048576n)).rejects.toMatchObject(tooBig)
    await expect(runtime.setGlobal("big", 1n << 1048576n)).rejects.toMatchObject(tooBig)
    await expect(runtime.call(mod.hook("kind"), 1n << (1n << 21n))).rejects.toMatchObject(tooBig)
  }, 30_000)
})
