import { expect, it } from "vitest"
import { createMoeJS, MoeJSError, type NativeHandle, type Value } from "moejs-wasm"

it("allows synchronous host callbacks to query and call their runtime and create promises", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const module = await engine.compile(
      "callback-runtime.js",
      `
      export function answer() { return 40 }
      export function invoke() { return host() }
    `
    )
    const runtime = await engine.newRuntime()
    await runtime.load(module)
    await runtime.setGlobal(
      "host",
      runtime.function("host", 0, async () => {
        expect(await runtime.module()).toBe(module)
        await runtime.stats()
        const answer = await runtime.call<number>(module.hook("answer"))
        const promise = await runtime.newPromise()
        await promise.resolve(answer + 2)
        return promise.promise
      })
    )
    expect(await runtime.call(module.hook("invoke"))).toBe(42)
    await runtime.setGlobal(
      "host",
      runtime.function("host", 0, async () => {
        const native = await runtime.native()
        const [promise, resolve, reject] = await native.invoke<NativeHandle[]>("NewPromise")
        const value = await promise!.asValue()
        await resolve!.call(42)
        expect((await runtime.promiseState(value)).state).toBe("fulfilled")
        await promise!.release()
        await resolve!.release()
        await reject!.release()
        return value
      })
    )
    expect(await runtime.call(module.hook("invoke"))).toBe(42)
  } finally {
    await engine.close()
  }
}, 30_000)

it("allows importer resolvers to query, call hooks and use native operations on their runtime", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const module = await engine.compile(
      "resolver-runtime.js",
      `
      export function load() { return import("dependency").then(ns => ns.answer) }
      export function side() { return "side" }
    `
    )
    const dependency = await engine.compile("resolver-dependency.js", "export const answer = 42")
    const visits: string[] = []
    const runtime = await engine.newRuntime({
      importer: {
        async resolve(referrer, specifier) {
          expect(referrer).toBe(module)
          expect(specifier).toBe("dependency")
          expect(await runtime.module()).toBe(module)
          expect((await runtime.stats()).Interrupts).toBe(0)
          visits.push(await runtime.call<string>(module.hook("side")))
          const native = await runtime.native()
          expect(await native.invoke("Realm")).toBe(await runtime.realm())
          await expect(runtime.eventLoop.stop()).rejects.toMatchObject({ kind: "host" })
          await expect(runtime.clearInterrupt()).rejects.toMatchObject({ kind: "host" })
          return dependency
        }
      }
    })
    await runtime.load(module)
    expect(await runtime.call(module.hook("load"))).toBe(42)
    expect(visits).toEqual(["side"])
  } finally {
    await engine.close()
  }
}, 30_000)

it("queries the actual module and native thrown value and mutable error stack", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const runtime = await engine.newRuntime()
    expect(await runtime.module()).toBeNull()
    const module = await engine.compile(
      "thrown-query.js",
      `
      export function fail() { throw new TypeError("bad request") }
    `
    )
    await runtime.load(module)
    expect(await runtime.module()).toBe(module)
    let caught: MoeJSError | undefined
    try {
      await runtime.call(module.hook("fail"))
    } catch (error) {
      if (!(error instanceof MoeJSError)) throw error
      caught = error
    }
    expect(caught?.kind).toBe("exception")
    const thrown = await runtime.thrownValue(caught)
    expect(thrown.ok).toBe(true)
    expect(thrown.value).toBe(caught!.value)
    expect(await runtime.stackTrace(caught)).toContain("TypeError: bad request")
    await runtime.setGlobal("caught", thrown.value)
    await runtime.evalScript("stack.js", `caught.stack = "changed stack"; undefined`)
    expect(await runtime.stackTrace(caught)).toBe("changed stack")
    expect((await runtime.thrownValue(null)).ok).toBe(false)
    const host = await runtime.thrownValue(new Error("host failure"))
    expect(host.ok).toBe(true)
    expect(await (await host.value.get("message")).toGo()).toBe("host failure")
    const reason = { requestId: 42, nested: ["cancelled"] }
    runtime.interrupt(reason)
    await expect(runtime.evalScript("interrupt.js", "1")).rejects.toMatchObject({
      kind: "interrupted",
      reason
    })
    await runtime.clearInterrupt()
  } finally {
    await engine.close()
  }
}, 30_000)

it("uses the native byte JSON parser's invalid UTF-8 conversion", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const runtime = await engine.newRuntime()
    const value: Value = await runtime.parseJSON(new Uint8Array([34, 255, 34]))
    expect(await value.toGo()).toBe("\uFFFD")
    await value.release()
  } finally {
    await engine.close()
  }
}, 30_000)
