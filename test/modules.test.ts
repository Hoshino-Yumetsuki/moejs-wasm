import { afterEach, expect, it } from "vitest"
import {
  createMoeJS,
  NativeHandle,
  type Engine,
  type Module,
  type MoeJSError,
  type Referrer,
  type Resolver
} from "moejs-wasm"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})
async function create() {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  engines.push(engine)
  return engine
}

it("links async-resolved cycles and reexports with native early exports", async () => {
  const engine = await create()
  const a = await engine.compile(
    "a.js",
    `
    import { read } from "b"
    export { read } from "b"
    export * from "value"
    export function answer() { return 42 }
    export const result = read()
  `
  )
  const b = await engine.compile(
    "b.js",
    `
    import { answer } from "a"
    export function read() { return answer() }
  `
  )
  let value: Module | undefined
  const linked = await engine.link(a, async (referrer, specifier) => {
    if (specifier === "a") return a
    if (specifier === "b") return b
    value ??= await engine.compile("value.js", "export const token = 7")
    return value
  })
  expect(linked.exports).toEqual(["answer", "read", "result", "token"])
  const runtime = await engine.newRuntime()
  await runtime.load(linked)
  expect(await runtime.call(linked.hook("read"))).toBe(42)
  expect(await runtime.call(a.hook("answer"))).toBe(42)
  expect(await runtime.get("token")).toBe(7)
}, 30_000)

it("shares static and concurrent dynamic module identity and supplies metadata", async () => {
  const engine = await create()
  const dep = await engine.compile(
    "dep.js",
    `
    globalThis.evaluations = (globalThis.evaluations || 0) + 1
    export const object = {}
    export const metadata = import.meta
  `
  )
  const entry = await engine.compile(
    "entry.js",
    `
    import * as statically from "dep"
    export async function inspect() {
      const [a, b] = await Promise.all([import("dep"), import("dep")])
      return [a === b, a === statically, a.object === statically.object,
        globalThis.evaluations, a.metadata.url, a.metadata.custom]
    }
  `
  )
  const linked = await engine.link(entry, () => dep)
  let resolutions = 0
  const runtime = await engine.newRuntime({
    importer: {
      resolve() {
        resolutions++
        return dep
      },
      async meta(module) {
        return { url: module.name, custom: module.name === "dep.js" ? 9 : 0 }
      }
    }
  })
  await runtime.load(linked)
  expect(await runtime.call(linked.hook("inspect"))).toEqual([true, true, true, 1, "dep.js", 9])
  expect(resolutions).toBe(2)
}, 30_000)

it("provides script referrers to every import()", async () => {
  const engine = await create()
  const script = await engine.compileScript(
    "script.js",
    `(async () => {
    const [a, b] = await Promise.all([import("dynamic"), import("dynamic")])
    return [a === b, a.value]
  })()`
  )
  const referrers: (Referrer | undefined)[] = []
  let dynamic: Promise<Module> | undefined
  const runtime = await engine.newRuntime({
    importer: {
      async resolve(referrer) {
        referrers.push(referrer)
        return (dynamic ??= engine.compile("dynamic.js", "export const value = 17"))
      }
    }
  })
  expect(await runtime.runScript(script)).toEqual([true, 17])
  expect(await runtime.runScript(script)).toEqual([true, 17])
  expect(referrers).toEqual([script, script, script, script])
}, 30_000)

// These guest import() expressions intentionally exercise dynamic module-loading boundaries.
it("supplies the actual native Compile module to mutable import.meta callbacks", async () => {
  const engine = await create()
  const dependency = await engine.compile("native-dynamic.js", "export const value = 19")
  let entry: NativeHandle
  const runtime = await engine.newRuntime({
    importer: {
      resolve(referrer, specifier) {
        expect(referrer).toBe(entry)
        expect(referrer?.name).toBe("native-meta.js")
        expect(specifier).toBe("dynamic")
        return dependency
      },
      async meta(module, meta) {
        expect(module).toBe(entry)
        expect(module).toBeInstanceOf(NativeHandle)
        expect(module.name).toBe("native-meta.js")
        expect(await (module as NativeHandle).invoke("Name")).toBe(module.name)
        const define = await runtime.evalScriptValue(
          "define-native-meta.js",
          `(function (name) { Object.defineProperty(this, "url", { value: name }) })`
        )
        await define.call(meta, module.name)
        await define.release()
        return { custom: 23 }
      }
    }
  })
  const moejs = await runtime.native("moejs")
  entry = await moejs.invoke<NativeHandle>(
    "Compile",
    "native-meta.js",
    `export const metadata = [import.meta.url, import.meta.custom]
    export async function read() { return (await import("dynamic")).value }`
  )
  await (await runtime.native()).invoke("Load", entry)
  expect(await runtime.get("metadata")).toEqual(["native-meta.js", 23])
  expect(await (await runtime.getValue("read")).call(undefined)).toBe(19)
}, 30_000)

it("preserves actual native referrers through static linking and cached dynamic imports", async () => {
  const engine = await create()
  const dependency = await engine.compile(
    "dependency.js",
    "globalThis.nativeEvaluations = (globalThis.nativeEvaluations || 0) + 1; export const object = {}"
  )
  const referrers: (Referrer | undefined)[] = []
  let entry: NativeHandle
  const runtime = await engine.newRuntime({
    importer: {
      resolve(referrer, specifier) {
        expect(referrer).toBe(entry)
        expect(referrer).toBeInstanceOf(NativeHandle)
        expect(referrer?.name).toBe("native-entry.js")
        expect(specifier).toBe("dependency")
        referrers.push(referrer)
        return dependency
      },
      meta(module) {
        expect(module).toBe(entry)
        return { url: module.name }
      }
    }
  })
  const moejs = await runtime.native("moejs")
  const statically = await moejs.invoke<NativeHandle>(
    "Compile",
    "static.js",
    "export const value = 31"
  )
  entry = await moejs.invoke<NativeHandle>(
    "Compile",
    "native-entry.js",
    `import { value } from "static"
    export async function inspect() {
      const [a, b] = await Promise.all([import("dependency"), import("dependency")])
      return [a === b, value, globalThis.nativeEvaluations, import.meta.url]
    }`
  )
  const staticReferrers: NativeHandle[] = []
  const linked = await moejs.invoke<NativeHandle>(
    "Link",
    entry,
    (referrer: NativeHandle, specifier: string) => {
      expect(referrer).toBe(entry)
      expect(referrer.name).toBe("native-entry.js")
      expect(specifier).toBe("static")
      staticReferrers.push(referrer)
      return statically
    }
  )
  await (await runtime.native()).invoke("Load", linked)
  const inspect = await runtime.getValue("inspect")
  expect(await inspect.call(undefined)).toEqual([true, 31, 1, "native-entry.js"])
  expect(await inspect.call(undefined)).toEqual([true, 31, 1, "native-entry.js"])
  expect(staticReferrers).toEqual([entry])
  expect(referrers).toEqual([entry, entry, entry, entry])
}, 30_000)

it("supplies stable native CompileScript referrers to cached dynamic imports", async () => {
  const engine = await create()
  const dependency = await engine.compile("dynamic.js", "export const value = 17")
  const referrers: (Referrer | undefined)[] = []
  let script: NativeHandle
  const runtime = await engine.newRuntime({
    importer: {
      resolve(referrer, specifier) {
        expect(referrer).toBe(script)
        expect(referrer).toBeInstanceOf(NativeHandle)
        expect(referrer?.name).toBe("native-script.js")
        expect(specifier).toBe("dynamic")
        referrers.push(referrer)
        return dependency
      }
    }
  })
  const root = await runtime.native()
  script = await (
    await runtime.native("moejs")
  ).invoke<NativeHandle>(
    "CompileScript",
    "native-script.js",
    `globalThis.nativeScriptResult = Promise.all([import("dynamic"), import("dynamic")])
      .then(([a, b]) => [a === b, a.value]); undefined`
  )
  await root.invoke("RunScript", script)
  expect(await runtime.evalScript("result.js", "globalThis.nativeScriptResult")).toEqual([true, 17])
  await root.invoke("RunScript", script)
  expect(await runtime.evalScript("result.js", "globalThis.nativeScriptResult")).toEqual([true, 17])
  expect(referrers).toEqual([script, script, script, script])
}, 30_000)

it("rejects cross-engine modules and propagates resolver errors into import promises", async () => {
  const engine = await create()
  const other = await create()
  const own = await engine.compile("own.js", "export function read() { return 42 }")
  const foreign = await other.compile("foreign.js", "export function read() { return 1 }")
  const isolated = await engine.newRuntime()
  await isolated.load(own)
  await expect(isolated.call(foreign.hook("read"))).rejects.toMatchObject({ kind: "bridge" })
  const entry = await engine.compile("entry.js", `import "missing"; export const value = 1`)
  await expect(engine.link(entry, () => foreign)).rejects.toThrow("different MoeJS engine")
  const script = await engine.compileScript("script.js", `import("missing").catch(e => e.message)`)
  const runtime = await engine.newRuntime({
    importer: {
      resolve() {
        throw new Error("resolver refused")
      }
    }
  })
  expect(await runtime.runScript(script)).toBe("resolver refused")
}, 30_000)

it("links the same entry into independent graphs without sharing resolver choices", async () => {
  const engine = await create()
  const entry = await engine.compile("entry.js", `export * from "dependency"`)
  const a = await engine.compile("a.js", "export function first() { return 1 }")
  const b = await engine.compile("b.js", "export function second() { return 2 }")
  const linkedA = await engine.link(entry, () => a)
  const linkedB = await engine.link(linkedA, () => b)
  expect(linkedA.exports).toEqual(["first"])
  expect(linkedB.exports).toEqual(["second"])
  const first = await engine.newRuntime()
  const second = await engine.newRuntime()
  await Promise.all([first.load(linkedA), second.load(linkedB)])
  expect(await first.call(linkedA.hook("first"))).toBe(1)
  expect(await second.call(linkedB.hook("second"))).toBe(2)
}, 30_000)

it("shares own hooks across links but keeps reexport hooks in their linked graph", async () => {
  const engine = await create()
  const entry = await engine.compile(
    "entry.js",
    `
    import { read } from "dependency"
    export function own() { return read() }
    export { read } from "dependency"
    export * as namespace from "dependency"
  `
  )
  const a = await engine.compile("a.js", "export function read() { return 1 }")
  const b = await engine.compile("b.js", "export function read() { return 2 }")
  const linkedA = await engine.link(entry, () => a)
  const linkedB = await engine.link(entry, () => b)
  const runtime = await engine.newRuntime()
  await runtime.load(linkedA)
  // Native lookupOwn accepts an own slot from another Link of the same code.
  const own = linkedB.hook("own")
  expect(await runtime.has(own)).toBe(true)
  expect(await runtime.call(own)).toBe(1)
  const value = await runtime.callValue(own)
  expect(await value.export()).toBe(1)
  await value.release()
  for (const path of [["read"], ["namespace", "read"]]) {
    expect(await runtime.call(linkedA.hook(...path))).toBe(1)
    const foreign = linkedB.hook(...path)
    expect(await runtime.has(foreign)).toBe(false)
    await expect(runtime.call(foreign)).rejects.toThrow("moejs: hook not found")
    await expect(runtime.callValue(foreign)).rejects.toThrow("moejs: hook not found")
  }
}, 30_000)

it("keeps default metadata empty and supports empty linked namespaces", async () => {
  const engine = await create()
  const empty = await engine.compile("empty.js", "globalThis.loadedEmpty = true")
  const linkedEmpty = await engine.link(empty, () => {
    throw new Error("unexpected resolution")
  })
  expect(linkedEmpty.exports).toEqual([])
  const runtime = await engine.newRuntime()
  await runtime.load(linkedEmpty)
  const script = await engine.compileScript("read.js", "globalThis.loadedEmpty")
  expect(await runtime.runScript(script)).toBe(true)
  const metadata = await engine.compile(
    "module-url.js",
    "export function url() { return import.meta.url }"
  )
  const second = await engine.newRuntime()
  await second.load(metadata)
  expect(await second.call(metadata.hook("url"))).toBeUndefined()
}, 30_000)

it("bounds asynchronous linking without poisoning subsequent resolutions", async () => {
  const engine = await create()
  const entry = await engine.compile("entry.js", `export { value } from "dep"`)
  const dependency = await engine.compile("dep.js", "export const value = 42")
  const controller = new AbortController()
  const { promise: waiting } = Promise.withResolvers<Module>()
  const pending = engine.link(entry, () => waiting, { signal: controller.signal })
  controller.abort(new Error("cancel resolver"))
  await expect(pending).rejects.toThrow("cancel resolver")
  await expect(engine.link(entry, () => waiting, { timeoutMs: 20 })).rejects.toMatchObject({
    kind: "timeout"
  })
  const linked = await engine.link(entry, () => dependency)
  const runtime = await engine.newRuntime()
  await runtime.load(linked)
  expect(await runtime.get("value")).toBe(42)
}, 30_000)

it("lets metadata callbacks mutate the native object with guest property descriptors", async () => {
  const engine = await create()
  const module = await engine.compile(
    "meta.js",
    `
    export const metadata = import.meta
    export function inspect() {
      const descriptor = Object.getOwnPropertyDescriptor(metadata, "token")
      return [Object.getPrototypeOf(metadata) === null, metadata.token,
        descriptor.writable, descriptor.enumerable, "url" in metadata]
    }
  `
  )
  const runtime = await engine.newRuntime({
    importer: {
      resolve() {
        throw new Error("unexpected resolution")
      },
      async meta(_module, metadata) {
        const define = await runtime.evalScriptValue(
          "define.js",
          `(function () {
          Object.defineProperty(this, "token", { value: { answer: 42 }, enumerable: false })
        })`
        )
        await define.call(metadata)
        await define.release()
      }
    }
  })
  await runtime.load(module)
  expect(await runtime.call(module.hook("inspect"))).toEqual([
    true,
    { answer: 42 },
    false,
    false,
    false
  ])
}, 30_000)

it("preserves native load failures before and after the first await", async () => {
  const engine = await create()
  const early = await engine.compile(
    "early.js",
    `
    export const initialized = 7
    export function read() { return initialized }
    throw new Error("early failure")
  `
  )
  const first = await engine.newRuntime()
  await expect(first.load(early)).rejects.toThrow("early failure")
  expect((await first.export("initialized")).ok).toBe(true)
  expect((await first.export("read")).ok).toBe(false)
  await expect(first.has(early.hook("read"))).rejects.toThrow("early failure")
  await expect(first.call(early.hook("read"))).rejects.toThrow("early failure")
  const late = await engine.compile(
    "late.js",
    `
    export const initialized = 9
    export function read() { return initialized }
    await Promise.resolve()
    throw new Error("late failure")
  `
  )
  const second = await engine.newRuntime()
  await expect(second.load(late)).rejects.toThrow("late failure")
  expect((await second.export("read")).ok).toBe(true)
  expect(await second.has(late.hook("read"))).toBe(true)
  expect(await second.call(late.hook("read"))).toBe(9)
}, 30_000)

it("retains resolver specifiers, source positions and causes", async () => {
  const engine = await create()
  const entry = await engine.compile("resolve.js", `\nexport { value } from "unavailable"`)
  await expect(
    engine.link(entry, () => {
      throw new TypeError("offline")
    })
  ).rejects.toMatchObject({
    name: "ResolveError",
    file: "resolve.js",
    line: 2,
    specifier: "unavailable",
    cause: { name: "TypeError", message: "offline" }
  })
}, 30_000)

it("blocks native hooks when an asynchronous dependency fails before the entry runs", async () => {
  const engine = await create()
  const dependency = await engine.compile(
    "dependency.js",
    `
    await Promise.resolve()
    throw new Error("dependency failure")
  `
  )
  const entry = await engine.compile(
    "entry.js",
    `
    import "dependency"
    export function read() { return 42 }
  `
  )
  const linked = await engine.link(entry, () => dependency)
  const runtime = await engine.newRuntime()
  await expect(runtime.load(linked)).rejects.toThrow("dependency failure")
  expect((await runtime.export("read")).ok).toBe(false)
  await expect(runtime.has(linked.hook("read"))).rejects.toThrow("dependency failure")
}, 30_000)

it("cancels a suspended runtime resolver without caching its unfinished promise", async () => {
  const engine = await create()
  // Dynamic import is required to reach the runtime resolver, not the static linker.
  const entry = await engine.compile(
    "runtime-resolution.js",
    `
    export async function read() { return (await import("dep")).value }
  `
  )
  const dependency = await engine.compile("resolved.js", "export const value = 42")
  const waiting = Promise.withResolvers<Module>()
  const started = Promise.withResolvers<void>()
  let first = true
  const runtime = await engine.newRuntime({
    importer: {
      resolve() {
        if (first) {
          first = false
          started.resolve()
          return waiting.promise
        }
        return dependency
      }
    }
  })
  await runtime.load(entry)
  const interrupted = expect(runtime.call(entry.hook("read"))).rejects.toMatchObject({
    kind: "interrupted"
  })
  await started.promise
  runtime.interrupt({ operation: "resolve" })
  await interrupted
  await runtime.clearInterrupt()
  expect(await runtime.call(entry.hook("read"))).toBe(42)
}, 30_000)

it("relinks an interrupted dynamic graph on the next import()", async () => {
  const engine = await create()
  // A dynamic import must reach the runtime resolver before its static child stalls.
  const entry = await engine.compile(
    "entry.js",
    `
    export async function read() { return (await import("dynamic")).value }
  `
  )
  const dynamic = await engine.compile("dynamic.js", `export { value } from "child"`)
  const child = await engine.compile("child.js", "export const value = 42")
  const waiting = Promise.withResolvers<Module>()
  const started = Promise.withResolvers<void>()
  let dynamicResolutions = 0
  let childResolutions = 0
  const runtime = await engine.newRuntime({
    importer: {
      resolve(referrer, specifier) {
        if (specifier === "dynamic") {
          dynamicResolutions++
          return dynamic
        }
        expect(referrer).toBe(dynamic)
        expect(specifier).toBe("child")
        childResolutions++
        if (childResolutions === 1) {
          started.resolve()
          return waiting.promise
        }
        return child
      }
    }
  })
  await runtime.load(entry)
  const interrupted = expect(runtime.call(entry.hook("read"))).rejects.toMatchObject({
    kind: "interrupted"
  })
  await started.promise
  runtime.interrupt({ operation: "nested static resolution" })
  await interrupted
  await runtime.clearInterrupt()
  expect(await runtime.call(entry.hook("read"))).toBe(42)
  expect(dynamicResolutions).toBe(2)
  expect(childResolutions).toBe(2)
  // Settle the canceled resolver after its replacement populated the cache.
  waiting.resolve(child)
  expect(await runtime.call(entry.hook("read"))).toBe(42)
  expect(dynamicResolutions).toBe(3)
  expect(childResolutions).toBe(2)
}, 30_000)

it("keeps an in-flight import() pending when the runtime is interrupted", async () => {
  const engine = await create()
  const entry = await engine.compile(
    "pending-import.js",
    'export async function read() { return (await import("dep")).value }'
  )
  const dependency = await engine.compile("dep.js", "export const value = 42")
  const started = Promise.withResolvers<void>()
  const events: { operation: string }[] = []
  let first = true
  const runtime = await engine.newRuntime({
    importer: {
      resolve() {
        if (!first) return dependency
        first = false
        started.resolve()
        return new Promise<Module>(() => {})
      }
    },
    onPromiseRejection: (event) => events.push(event)
  })
  await runtime.load(entry)
  const interrupted = expect(runtime.call(entry.hook("read"))).rejects.toMatchObject({
    kind: "interrupted"
  })
  await started.promise
  runtime.interrupt({ operation: "resolve" })
  await interrupted
  await runtime.clearInterrupt()
  expect(events.filter((event) => event.operation === "reject")).toEqual([])
  expect(await runtime.call(entry.hook("read"))).toBe(42)
}, 30_000)

it("rejects a later import() of a module whose evaluation was interrupted", async () => {
  const engine = await create()
  const main = await engine.compile(
    "main.js",
    'const why = (e) => e.constructor.name + ":" + e.message\nexport const imp = (s) => import(s).then(() => "ok", why)'
  )
  const spin = await engine.compile("spin.js", "for (;;);")
  const wrap = await engine.compile("wrap.js", 'import "./spin.js"')
  const runtime = await engine.newRuntime({
    maxSteps: 100_000,
    importer: { resolve: (_referrer, specifier) => (specifier === "./spin.js" ? spin : wrap) }
  })
  await runtime.load(main)
  await expect(runtime.call(main.hook("imp"), "./spin.js")).rejects.toMatchObject({
    kind: expect.stringMatching(/^(budget|interrupted)$/)
  })
  await runtime.clearInterrupt()
  expect(await runtime.call(main.hook("imp"), "./spin.js")).toBe(
    'Error:Cannot import "./spin.js": its evaluation was interrupted'
  )
  expect(await runtime.call(main.hook("imp"), "./wrap.js")).toBe(
    'Error:Cannot import "./wrap.js": its evaluation was interrupted'
  )
}, 30_000)

it("refuses to load an unlinked module that imports, with or without an importer", async () => {
  const engine = await create()
  const refused = await engine.compile("refused.js", 'import "secret.js"')
  const secret = await engine.compile("secret.js", "export const s = 1")
  let calls = 0
  const message =
    'moejs: module "refused.js" imports "secret.js": link it with moejs.Link and a resolver'
  for (const importer of [undefined, { resolve: () => (calls++, secret) }]) {
    const rt = await engine.newRuntime({ importer })
    await expect(rt.load(refused)).rejects.toMatchObject({ message })
    expect(await rt.module()).toBeNull()
  }
  expect(calls).toBe(0)
  const free = await engine.compile("free.js", "export const f = 1")
  expect(await engine.link(free, undefined as unknown as Resolver)).toBe(free)
}, 30_000)

it("refuses a second load with the upstream message", async () => {
  const engine = await create()
  const a = await engine.compile("a.js", "export function f() { return 1 }")
  const b = await engine.compile("b.js", "export const g = 2")
  const rt = await engine.newRuntime()
  await rt.load(a)
  await expect(rt.load(b)).rejects.toMatchObject({
    message: "moejs: runtime already loaded module a.js"
  })
  expect(await rt.module()).toBe(a)
  expect(await rt.call(a.hook("f"))).toBe(1)
}, 30_000)

it("reports Link resolver failures with upstream causes", async () => {
  const engine = await create()
  const refused = await engine.compile("refused.js", 'import "secret.js"')
  await expect(engine.link(refused, undefined as unknown as Resolver)).rejects.toMatchObject({
    name: "ResolveError",
    code: "ERR_MODULE_RESOLVE",
    file: "refused.js",
    line: 1,
    column: 8,
    specifier: "secret.js",
    message:
      'refused.js:1:8: cannot resolve module "secret.js": no resolver: the host must resolve the module\'s requests',
    cause: { code: "ERR_NO_RESOLVER" }
  })
  const nil = await engine.compile("nilmod.js", 'import "nil.js"')
  await expect(engine.link(nil, () => null)).rejects.toMatchObject({
    specifier: "nil.js",
    cause: { message: "the resolver returned no module template" }
  })
  await expect(
    engine.link(refused, () => {
      throw new Error("host says no")
    })
  ).rejects.toMatchObject({
    message: 'refused.js:1:8: cannot resolve module "secret.js": host says no'
  })
}, 30_000)

it("passes the module the resolver returned as the referrer of its requests", async () => {
  const engine = await create()
  const sources: Record<string, string> = {
    "top.js": 'import { d } from "dep.js"\nexport const t = d',
    "dep.js": 'import { l } from "leaf.js"\nexport const d = l + "!"',
    "leaf.js": 'export const l = "dep"'
  }
  const compiled = new Map<string, Module>()
  for (const [name, source] of Object.entries(sources))
    compiled.set(name, await engine.compile(name, source))
  const seen: string[] = []
  const byName: Resolver = (referrer, specifier) => {
    seen.push(`${referrer?.name} -> ${specifier}`)
    return compiled.get(specifier)!
  }
  const linkedDep = await engine.link(compiled.get("dep.js")!, byName)
  seen.length = 0
  const linked = await engine.link(compiled.get("top.js")!, (referrer, specifier) => {
    if (specifier === "dep.js") {
      seen.push(`${referrer?.name} -> ${specifier}`)
      return linkedDep
    }
    expect(referrer).toBe(linkedDep)
    return byName(referrer, specifier)
  })
  expect(seen).toEqual(["top.js -> dep.js", "dep.js -> leaf.js"])
  const rt = await engine.newRuntime()
  await rt.load(linked)
  expect(await rt.get("t")).toBe("dep!")
}, 30_000)

it("surfaces ErrModulePending and runs hooks while the graph awaits", async () => {
  const engine = await create()
  const sources: Record<string, string> = {
    "main.js":
      'import { v } from "dep.js"; import "log.js"; log("main");\nexport function get() { return v; }\nexport function order() { return seen.join(); }',
    "dep.js": 'import "log.js"; log("dep1"); export const v = await wait(); log("dep2");',
    "log.js": "globalThis.seen = []; globalThis.log = (s) => seen.push(s);"
  }
  const compiled = new Map<string, Module>()
  for (const [name, source] of Object.entries(sources))
    compiled.set(name, await engine.compile(name, source))
  const linked = await engine.link(compiled.get("main.js")!, (_r, s) => compiled.get(s)!)
  const rt = await engine.newRuntime()
  const host = await rt.newPromise()
  await rt.setGlobal(
    "wait",
    rt.function("wait", 0, () => host.promise)
  )
  await expect(rt.load(linked)).rejects.toMatchObject({ code: "ERR_MODULE_PENDING" })
  expect(await rt.module()).toBe(linked)
  await expect(rt.call(linked.hook("get"))).rejects.toMatchObject({
    kind: "exception",
    name: "ReferenceError"
  })
  expect(await rt.call(linked.hook("order"))).toBe("dep1")
  const other = await engine.compile("other.js", "export const o = 1")
  await expect(rt.load(other)).rejects.toMatchObject({
    message: "moejs: runtime already loaded module main.js"
  })
  await host.resolve("ready")
  expect(await rt.call(linked.hook("get"))).toBe("ready")
  expect(await rt.call(linked.hook("order"))).toBe("dep1,dep2,main")
}, 30_000)

it("fails a graph's hooks with the interrupt raised from a host callback", async () => {
  const engine = await create()
  const dep = await engine.compile("dep.js", "stop(); for (;;) {}")
  const entry = await engine.compile(
    "entry.js",
    'import "dep.js"\nexport function read() { return 42 }'
  )
  const linked = await engine.link(entry, () => dep)
  const rt = await engine.newRuntime()
  await rt.setGlobal(
    "stop",
    rt.function("stop", 0, () => {
      rt.interrupt("stop")
    })
  )
  await expect(rt.load(linked)).rejects.toMatchObject({ kind: "interrupted" })
  await rt.clearInterrupt()
  await expect(rt.has(linked.hook("read"))).rejects.toMatchObject({ kind: "interrupted" })
}, 30_000)

it("resolves hooks through upstream lookup", async () => {
  const engine = await create()
  const a = await engine.compile("a.js", "export function f() { return 1 }\nexport const n = 2")
  const b = await engine.compile("b.js", "export function g() { return 3 }")
  const rt = await engine.newRuntime()
  const notFound = { code: "ERR_HOOK_NOT_FOUND", message: "moejs: hook not found" }
  expect(await rt.has(a.hook("f"))).toBe(false)
  await expect(rt.call(a.hook("f"))).rejects.toMatchObject(notFound)
  await expect(rt.callValue(a.hook("f"))).rejects.toMatchObject(notFound)
  await rt.load(a)
  expect(await rt.has(a.hook("f"))).toBe(true)
  expect(await rt.has(a.hook("n"))).toBe(false)
  expect(await rt.has(b.hook("g"))).toBe(false)
  await expect(rt.call(b.hook("g"))).rejects.toMatchObject(notFound)
  expect(() => a.hook()).toThrow(expect.objectContaining(notFound))
}, 30_000)

it("calls resolve for every import(), static specifiers included", async () => {
  const engine = await create()
  const dep = await engine.compile("dep.js", "export const d = 1")
  const entry = await engine.compile(
    "entry.js",
    'import * as s from "dep"\nexport async function run() { const [a, b] = await Promise.all([import("dep"), import("dep")]); return [a === s, b === s] }'
  )
  const linked = await engine.link(entry, () => dep)
  const referrers: (Referrer | undefined)[] = []
  const rt = await engine.newRuntime({
    importer: {
      resolve(referrer) {
        referrers.push(referrer)
        return dep
      }
    }
  })
  await rt.load(linked)
  expect(await rt.call(linked.hook("run"))).toEqual([true, true])
  expect(referrers).toEqual([entry, entry])
}, 30_000)

it("resolves a dynamically imported graph's static imports once per runtime", async () => {
  const engine = await create()
  const compiled = new Map<string, Module>([
    [
      "./a.js",
      await engine.compile("a.js", 'import { w } from "./b.js"\nexport const v = w + "a"')
    ],
    ["./b.js", await engine.compile("b.js", 'export const w = "b"')]
  ])
  const entry = await engine.compile(
    "entry.js",
    'export async function run() { globalThis.after = false; const p = import("./a.js"); globalThis.after = true; return (await p).v }'
  )
  const calls: string[] = []
  const rt = await engine.newRuntime({
    importer: {
      async resolve(referrer, specifier) {
        const after = await rt.evalScript<boolean>("after.js", "globalThis.after")
        calls.push(`${referrer?.name} -> ${specifier} ${after}`)
        return compiled.get(specifier)!
      }
    }
  })
  await rt.load(entry)
  expect(await rt.call(entry.hook("run"))).toBe("ba")
  expect(await rt.call(entry.hook("run"))).toBe("ba")
  expect(calls).toEqual([
    "entry.js -> ./a.js false",
    "a.js -> ./b.js false",
    "entry.js -> ./a.js false"
  ])
}, 30_000)

it("rejects import() with a resolver's guest exception, with SyntaxError, and without a resolve hook", async () => {
  const engine = await create()
  const importer = await engine.compile(
    "importer.js",
    "export function imp(s) { return import(s).then(() => 'fulfilled', (e) => [e instanceof SyntaxError, String(e)]) }"
  )
  let thrown = await engine.newRuntime({
    importer: {
      async resolve() {
        await thrown.evalScript("t.js", "throw 7")
        return undefined
      }
    }
  })
  await thrown.load(importer)
  expect(await thrown.call(importer.hook("imp"), "x")).toEqual([false, "7"])
  const bad = (await engine
    .compile("bad.js", "export const =")
    .catch((error: unknown) => error)) as MoeJSError
  const syntax = await engine.newRuntime({
    importer: { resolve: () => engine.compile("bad.js", "export const =") }
  })
  await syntax.load(importer)
  const [isSyntax, text] = await syntax.call<[boolean, string]>(importer.hook("imp"), "x")
  expect(isSyntax).toBe(true)
  expect(text).toBe(`SyntaxError: ${bad.file}:${bad.line}:${bad.column}: ${bad.message}`)
  const dynamic = await engine.compile("dyn.js", 'import "child"\nexport const d = 1')
  const nested = await engine.newRuntime({
    importer: {
      resolve: (_r, s) => (s === "child" ? engine.compile("child.js", "export const =") : dynamic)
    }
  })
  await nested.load(importer)
  expect((await nested.call<[boolean, string]>(importer.hook("imp"), "dyn"))[0]).toBe(true)
  const tla = await engine.compile(
    "tla.js",
    'export const out = await import("./m.js").then(() => "fulfilled", String)'
  )
  const metaOnly = await engine.newRuntime({ importer: { meta: () => ({}) } })
  await metaOnly.load(tla)
  expect(await metaOnly.get("out")).toBe(
    'TypeError: Cannot import "./m.js": the host set no import hook (moejs.Options.Importer, engine.Realm.SetImportHooks)'
  )
  const none = await engine.newRuntime({ importer: { resolve: () => null } })
  await none.load(tla)
  expect(await none.get("out")).toBe('TypeError: Cannot import "./m.js": the host loaded no module')
}, 30_000)

it("finds the instance a load evaluated alone through import(), and reports inconsistent re-resolution", async () => {
  const engine = await create()
  const m = await engine.compile(
    "m.js",
    "globalThis.mruns = (globalThis.mruns ?? 0) + 1; export let n = 0; export function inc() { n++ }"
  )
  const alone = await engine.newRuntime({ importer: { resolve: () => m } })
  await alone.load(m)
  await alone.call(m.hook("inc"))
  const script = await engine.compileScript(
    "s.js",
    'import("./m.js").then((ns) => ns.n + "," + globalThis.mruns)'
  )
  expect(await alone.runScript(script)).toBe("1,1")
  const main = await engine.compile(
    "main.js",
    'import { d } from "./dep.js"; export const out = d;'
  )
  const dep = await engine.compile("dep.js", 'export const d = "one";')
  const dep2 = await engine.compile("dep2.js", 'export const d = "two";')
  const rt = await engine.newRuntime({
    importer: { resolve: (_r, s) => (s === "./main.js" ? main : dep) }
  })
  await rt.evalScript("first.js", 'import("./main.js").then((ns) => { globalThis.out = ns.out })')
  const linked = await engine.link(main, () => dep2)
  await expect(rt.load(linked)).rejects.toMatchObject({
    name: "ResolveError",
    code: "ERR_MODULE_RESOLVE",
    file: "main.js",
    line: 1,
    column: 19,
    specifier: "./dep.js",
    message:
      'main.js:1:19: cannot resolve module "./dep.js": the graph resolves it to dep2.js, but the realm instantiated main.js with dep.js'
  })
  expect(await rt.evalScript("out.js", "out")).toBe("one")
}, 30_000)
