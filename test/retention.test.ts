import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { afterEach, expect, it } from "vitest"
import {
  createMoeJS,
  MoeJSError,
  type Engine,
  type Module,
  type NativeHandle,
  type Runtime,
  type RuntimeOptions,
  type Value
} from "moejs-wasm"

setFlagsFromString("--expose-gc")
const gc = runInNewContext("gc") as () => void
async function collect() {
  for (let i = 0; i < 4; i++) {
    gc()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
interface Retention {
  values: number
  natives: number
  callbacks: number
  symbols: number
  scripts: number
  modules: number
  heap: number
  gcPercent: number
  goMemoryLimit: number
}
interface Endpoint {
  control<T>(op: string, payload?: object): Promise<T>
  callbacks: Map<number, unknown>
}
const transport = (rt: Runtime) => (rt as unknown as { transport: Endpoint }).transport
// Collects on both sides: TS releases first, then Go collects and reports what it still holds.
async function retention(rt: Runtime) {
  await collect()
  const r = await transport(rt).control<Retention>("debugRetention")
  await collect()
  return r
}

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})
async function setup(source: string, options: RuntimeOptions = {}) {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  const mod = await engine.compile("retention.js", source)
  const rt = await engine.newRuntime(options)
  await rt.load(mod)
  return { engine, rt, hook: (name: string) => mod.hook(name) }
}
const source = `
export function use(cb) { return cb(1) }
export function make() { return () => 1 }
export function fail(i) { throw { i } }
export function echo(x) { return x }
export function read(v) { return v.n }
export function waitHost(f) { return f() }
`

it("releases host callback registrations once the guest drops them", async () => {
  const { rt, hook } = await setup(source)
  for (let i = 0; i < 500; i++)
    expect(await rt.call(hook("use"), (n: unknown) => Number(n) + 1)).toBe(2)
  expect((await retention(rt)).callbacks).toBeLessThanOrEqual(32)
  expect(transport(rt).callbacks.size).toBeLessThanOrEqual(32)
}, 40_000)

it("keeps a host callback the guest stores and calls later", async () => {
  const { rt } = await setup(source)
  await rt.setGlobal("saved", () => 7)
  await retention(rt)
  await retention(rt)
  expect(await rt.evalScript("saved.js", "saved()")).toBe(7)
}, 40_000)

it("releases a callback encoded for a request that is never sent", async () => {
  const { rt, hook } = await setup(source)
  const before = transport(rt).callbacks.size
  await expect(
    rt.callWith(hook("use"), [() => 1], { signal: AbortSignal.abort() })
  ).rejects.toBeDefined()
  await collect()
  expect(transport(rt).callbacks.size).toBe(before)
}, 40_000)

it("gives each crossing of a host function a fresh guest function, while a Value keeps identity", async () => {
  const { rt } = await setup(source)
  const fn = () => 1
  await rt.setGlobal("a", fn)
  await rt.setGlobal("b", fn)
  expect(await rt.evalScript("fresh.js", "a === b")).toBe(false)
  const value = await rt.fromHost(fn)
  await rt.setGlobal("a", value)
  await rt.setGlobal("b", value)
  expect(await rt.evalScript("same.js", "a === b")).toBe(true)
}, 40_000)

it("releases dropped Value handles", async () => {
  const { rt, hook } = await setup(source)
  for (let i = 0; i < 500; i++) await rt.callValue(hook("make"))
  expect((await retention(rt)).values).toBeLessThanOrEqual(64)
}, 40_000)

it("releases error values once the MoeJSError is dropped, and keeps a held one", async () => {
  const { rt, hook } = await setup(source)
  for (let i = 0; i < 500; i++)
    expect(await rt.call(hook("fail"), i).catch((error: MoeJSError) => error.kind)).toBe(
      "exception"
    )
  const kept = (await rt.call(hook("fail"), 5).catch((error: unknown) => error)) as MoeJSError
  expect((await retention(rt)).values).toBeLessThanOrEqual(64)
  expect(await (await (kept.value as Value).get("i")).toGo()).toBe(5)
}, 40_000)

it("releases the handles of rejection events", async () => {
  const { rt } = await setup(source, { onPromiseRejection: () => {} })
  for (let i = 0; i < 300; i++) await rt.evalScript("reject.js", "Promise.reject(1); undefined")
  expect((await retention(rt)).values).toBeLessThanOrEqual(64)
}, 40_000)

it("keeps a handle valid that Go re-sent while an older handle for it was being released", async () => {
  const { rt } = await setup(source)
  const retained = "globalThis.retained ??= { count: 4 }"
  const a = await rt.evalScriptValue("a.js", retained)
  const pending = rt.evalScriptValue("b.js", retained)
  const released = a.release()
  const b = await pending
  await released
  expect(b).not.toBe(a)
  expect(await b.export()).toEqual({ count: 4 })
}, 40_000)

it("keeps a Value that only a queued request references until the request runs", async () => {
  const { rt, hook } = await setup(source)
  let value: Value | undefined = await rt.evalScriptValue("value.js", "({ n: 3 })")
  const gate = Promise.withResolvers<number>()
  const first = rt.call(hook("waitHost"), () => gate.promise)
  const second = rt.call(hook("read"), value)
  value = undefined
  await collect()
  gate.resolve(1)
  expect(await first).toBe(1)
  expect(await second).toBe(3)
}, 40_000)

it("applies releases while an async call is pending", async () => {
  const { rt, hook } = await setup(source)
  let handles: Value[] = []
  for (let i = 0; i < 100; i++) handles.push(await rt.callValue(hook("make")))
  const before = (await transport(rt).control<Retention>("debugRetention")).values
  const gate = Promise.withResolvers<number>()
  const call = rt.call(hook("waitHost"), () => gate.promise)
  handles = []
  await collect()
  expect((await transport(rt).control<Retention>("debugRetention")).values).toBeLessThan(
    before - 50
  )
  gate.resolve(1)
  expect(await call).toBe(1)
  expect(handles).toEqual([])
}, 40_000)

it("keeps an interrupt reason Value in later errors after the host drops it", async () => {
  const { rt, hook } = await setup(source)
  let reason: Value | undefined = await rt.fromHost({ x: 1 })
  rt.interrupt(reason)
  reason = undefined
  await collect()
  const error = (await rt.call(hook("echo"), 1).catch((e: unknown) => e)) as MoeJSError
  expect(error.kind).toBe("interrupted")
  await retention(rt)
  // Get runs guest code, which an interrupted runtime refuses, as upstream.
  await rt.clearInterrupt()
  expect(await (await (error.reason as Value).get("x")).toGo()).toBe(1)
}, 40_000)

it("releases native handles the host drops", async () => {
  const { rt } = await setup(source)
  for (let i = 0; i < 200; i++) await rt.native("realm")
  for (let i = 0; i < 200; i++) await rt.newDecodeTarget("int")
  expect((await retention(rt)).natives).toBeLessThanOrEqual(64)
}, 40_000)

it("keeps symbol tables bounded and a guest symbol the host holds", async () => {
  const { rt, hook } = await setup(source + "export function symbol() { return Symbol('g') }")
  for (let i = 0; i < 500; i++) {
    const symbol = Symbol("s" + i)
    expect(await rt.call(hook("echo"), symbol)).toBe(symbol)
  }
  const guest = await rt.call<symbol>(hook("symbol"))
  expect((await retention(rt)).symbols).toBeLessThanOrEqual(64)
  expect(await rt.call(hook("echo"), guest)).toBe(guest)
  expect(guest.description).toBe("g")
  expect(await rt.call(hook("echo"), guest)).toBe(guest)
}, 40_000)

it("releases the bytecode of scripts whose descriptors are dropped", async () => {
  const { engine, rt } = await setup(source)
  for (let i = 0; i < 100; i++)
    expect(await rt.runScript(await engine.compileScript(`s${i}.js`, `1 + ${i}`))).toBe(1 + i)
  const kept = await engine.compileScript("kept.js", "40 + 2")
  expect(await rt.runScript(kept)).toBe(42)
  expect((await retention(rt)).scripts).toBeLessThanOrEqual(16)
  expect(await rt.runScript(kept)).toBe(42)
}, 40_000)

it("keeps the referrer of a script that uses import() after the host drops it", async () => {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  const dep = await engine.compile("dep.js", "export const v = 1")
  const seen: (string | undefined)[] = []
  const rt = await engine.newRuntime({
    importer: {
      resolve: (referrer) => {
        seen.push(referrer?.name)
        return dep
      }
    }
  })
  await rt.runScript(
    await engine.compileScript("loader.js", "globalThis.load = () => import('dep'); undefined")
  )
  await retention(rt)
  expect(await rt.evalScript("call.js", "load().then((ns) => ns.v)")).toBe(1)
  expect(seen).toEqual(["loader.js"])
}, 40_000)

it("gives a dependency's import() its Module referrer after the host drops the descriptor", async () => {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  const late = await engine.compile("late.js", "export const v = 2")
  const seen: string[] = []
  let dep: Module | undefined = await engine.compile(
    "dep.js",
    "export const load = () => import('late').then((ns) => ns.v)"
  )
  const resolve = (referrer: { name: string } | undefined, specifier: string) => {
    seen.push(`${referrer?.name}:${specifier}`)
    return specifier === "dep" ? dep : late
  }
  const entry = await engine.link(
    await engine.compile("entry.js", "export { load } from 'dep'"),
    resolve
  )
  const rt = await engine.newRuntime({ importer: { resolve } })
  await rt.load(entry)
  dep = undefined
  await retention(rt)
  expect(await rt.call(entry.hook("load"))).toBe(2)
  expect(seen).toContain("dep.js:late")
}, 40_000)

it("releases compiled modules from the compiler endpoint", async () => {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  for (let i = 0; i < 60; i++) await engine.compile(`m${i}.js`, `export const v = ${i}`)
  await collect()
  const compiler = (engine as unknown as { compiler: Endpoint }).compiler
  expect((await compiler.control<Retention>("debugRetention")).modules).toBeLessThanOrEqual(16)
}, 40_000)

it("retains a bounded Go heap across pooled requests", async () => {
  const { rt, hook } = await setup(`
export function hook(req) {
  const out = {};
  let s = 0;
  for (const id of Object.keys(req.byId)) { out[id] = req.byId[id].n; s += out[id]; }
  const tally = {};
  tally[req.user] = (tally[req.user] || 0) + 1;
  tally[req.trace] = s;
  return Object.keys(out).length + Object.keys(tally).length;
}`)
  const arg = (i: number) => ({
    byId: Object.fromEntries(
      Array.from({ length: 8 }, (_, j) => [`id_${i}_${j}`, { n: j, model: "gpt" }])
    ),
    user: `user_${i}`,
    trace: `трасса_${i}`
  })
  const call = async (i: number) => {
    expect(await rt.call(hook("hook"), arg(i))).toBe(10)
    await rt.releaseCallData()
  }
  for (let i = 0; i < 200; i++) await call(i)
  const before = (await retention(rt)).heap
  for (let i = 200; i < 3_200; i++) await call(i)
  expect((await retention(rt)).heap - before).toBeLessThan(8 << 20)
}, 120_000)

it("sizes the Go collector of a runtime with gcPercent and goMemoryLimit", async () => {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  const rt = await engine.newRuntime({ gcPercent: 50, goMemoryLimit: 64 << 20 })
  expect(await transport(rt).control<Retention>("debugRetention")).toMatchObject({
    gcPercent: 50,
    goMemoryLimit: 64 << 20
  })
  await expect(engine.newRuntime({ goMemoryLimit: 0 })).rejects.toBeInstanceOf(RangeError)
  await expect(engine.newRuntime({ gcPercent: 1.5 })).rejects.toBeInstanceOf(RangeError)
}, 40_000)

it("keeps a module import() loaded as its referrer after the resolver dropped it", async () => {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  const sources: Record<string, string> = {
    m: "export const meta = () => import.meta.tag; export const later = () => import('n').then((ns) => ns.v)",
    n: "export const v = 3"
  }
  const seen: string[] = []
  const rt = await engine.newRuntime({
    importer: {
      resolve: async (referrer, specifier) => {
        seen.push(`${referrer?.name}:${specifier}`)
        return engine.compile(`${specifier}.js`, sources[specifier]!)
      },
      meta: (module) => ({ tag: module.name })
    }
  })
  await rt.evalScript("importer.js", "import('m').then((ns) => { globalThis.ns = ns }); undefined")
  for (let i = 0; i < 50 && !(await rt.evalScript("ready.js", "'ns' in globalThis")); i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  await retention(rt)
  expect(await rt.evalScript("meta.js", "ns.meta()")).toBe("m.js")
  expect(await rt.evalScript("later.js", "ns.later()")).toBe(3)
  expect(seen).toContain("m.js:n")
}, 40_000)

it("does not accumulate rt.function wrappers, posted tasks or live-root callbacks", async () => {
  const { rt } = await setup(source)
  for (let i = 0; i < 200; i++) {
    await rt.setGlobal(
      "f",
      rt.function("f", 0, () => 1)
    )
    await rt.eventLoop.post(() => {})
    const remove = await rt.addLiveRoots(() => {})
    await remove()
  }
  await retention(rt)
  expect(transport(rt).callbacks.size).toBeLessThan(32)
}, 40_000)

it("keeps a staged callback when Go releases an earlier crossing of the same function", async () => {
  const { rt, hook } = await setup(source)
  const fn = (n: unknown) => n
  const first = rt.call(hook("use"), fn)
  const second = rt.call(hook("use"), fn)
  expect(await first).toBe(1)
  await transport(rt).control("debugRetention")
  expect(await second).toBe(1)
}, 40_000)

it("mints no rejection handles once the tracker is cleared", async () => {
  const { rt } = await setup(source, { onPromiseRejection: () => {} })
  await rt.setPromiseRejectionTracker()
  for (let i = 0; i < 300; i++) await rt.evalScript("reject.js", "Promise.reject(1); undefined")
  expect((await retention(rt)).values).toBeLessThanOrEqual(64)
}, 40_000)

it("releases a native LiveReporter's callbacks with its function", async () => {
  const { rt } = await setup(source)
  const realm = await rt.realm()
  const baseline = (await retention(rt)).callbacks
  for (let i = 0; i < 20; i++)
    await realm.invoke<NativeHandle>("NewNativeDataFunction", "reporter", 0, async () => 1, {
      reportLive: async () => {}
    })
  await retention(rt)
  expect((await retention(rt)).callbacks).toBeLessThanOrEqual(baseline + 4)
}, 40_000)
