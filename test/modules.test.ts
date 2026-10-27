import { afterEach, expect, it } from "vitest"
import { createMoeJS, NativeHandle, type Engine, type Module, type Referrer } from "moejs-wasm"

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
  expect(resolutions).toBe(0)
}, 30_000)

it("provides script referrers and caches asynchronous resolver identity", async () => {
  const engine = await create()
  const script = await engine.compileScript(
    "script.js",
    `(async () => {
    const [a, b] = await Promise.all([import("dynamic"), import("dynamic")])
    return [a === b, a.value]
  })()`
  )
  const referrers: (Referrer | undefined)[] = []
  const runtime = await engine.newRuntime({
    importer: {
      async resolve(referrer) {
        referrers.push(referrer)
        return engine.compile("dynamic.js", "export const value = 17")
      }
    }
  })
  expect(await runtime.runScript(script)).toEqual([true, 17])
  expect(await runtime.runScript(script)).toEqual([true, 17])
  expect(referrers).toEqual([script])
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
  expect(referrers).toEqual([entry])
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
  expect(referrers).toEqual([script])
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

it("evicts an interrupted static child after the dynamic entry has resolved", async () => {
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
  expect(dynamicResolutions).toBe(1)
  expect(childResolutions).toBe(2)
  // Settle the canceled resolver after its replacement populated the cache.
  waiting.resolve(child)
  expect(await runtime.call(entry.hook("read"))).toBe(42)
  expect(childResolutions).toBe(2)
}, 30_000)
