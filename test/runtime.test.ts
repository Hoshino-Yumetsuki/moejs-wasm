import { afterEach, describe, expect, it } from "vitest"
import { createMoeJS, MoeJSError, type Engine } from "moejs-wasm"

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
    await rt.setGlobal("host", {
      prefix: async () => "answer:",
      double: async (n: unknown) => Number(n) * 2,
      fail: () => {
        throw new Error("host denied")
      }
    })
    await rt.load(mod)
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
    await expect(rt.call(mod.hook("spin"))).rejects.toMatchObject({ kind: "budget" })
    const limited = await engine.newRuntime({ memoryLimit: 1_000_000 })
    await limited.load(mod)
    await expect(limited.call(mod.hook("allocate"))).rejects.toMatchObject({ kind: "memory" })
    const fresh = await engine.newRuntime()
    await fresh.load(mod)
    expect(await fresh.call(mod.hook("ok"))).toBe(42)
  }, 30_000)

  it("does not replenish CPU fuel when host promises settle", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "async-budget.js",
      `
      export async function spin() {
        try { for (;;) { await host.tick() } }
        catch { return "escaped" }
      }
    `
    )
    const rt = await engine.newRuntime({ maxSteps: 1000 })
    await rt.setGlobal("host", { tick: async () => null })
    await rt.load(mod)
    await expect(rt.call(mod.hook("spin"))).rejects.toMatchObject({ kind: "budget" })
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
    await expect(runtime.call(mod.hook("allocate"))).rejects.toMatchObject({ kind: "memory" })
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

  it("bounds pending promises and can close an outstanding call immediately", async () => {
    const engine = await create()
    const mod = await engine.compile(
      "pending.js",
      "export function wait() { return new Promise(() => {}) }"
    )
    const rt = await engine.newRuntime({ timeoutMs: 1000 })
    await rt.load(mod)
    await expect(rt.call(mod.hook("wait"))).rejects.toMatchObject({ kind: "timeout" })
    const other = await engine.newRuntime()
    await other.load(mod)
    const pending = other.call(mod.hook("wait"))
    const assertion = expect(pending).rejects.toMatchObject({ kind: "closed" })
    await other.close()
    await assertion
  }, 30_000)
})
