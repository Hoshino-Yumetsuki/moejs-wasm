import { afterEach, expect, it } from "vitest"
import {
  createMoeJS,
  nodeAdapter,
  type Adapter,
  type Engine,
  type WorkerRequest
} from "moejs-wasm/node"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})

// Corrupt only source text in runtime messages. Successful execution therefore
// demonstrates that independent WASM endpoints consume the compiled artifact.
function artifactAdapter(transform?: (request: WorkerRequest) => WorkerRequest): Adapter {
  const native = nodeAdapter()
  let worker = 0
  return {
    loadModule: (url) => native.loadModule(url),
    async createWorker(module, options, handlers) {
      const endpoint = await native.createWorker(module, options, handlers)
      if (worker++ === 0) return endpoint
      return {
        terminate: () => endpoint.terminate(),
        postMessage(request) {
          const replaceSource = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(replaceSource)
            if (value && typeof value === "object") {
              return Object.fromEntries(
                Object.entries(value).map(([key, child]) => [
                  key,
                  key === "source" ? "this is not valid JavaScript {{{" : replaceSource(child)
                ])
              )
            }
            return value
          }
          const next = { ...request, payload: replaceSource(request.payload) as object }
          endpoint.postMessage(transform ? transform(next) : next)
        }
      }
    }
  }
}

function recordingAdapter(sent: WorkerRequest[]): Adapter {
  const native = nodeAdapter()
  return {
    loadModule: (url) => native.loadModule(url),
    async createWorker(module, options, handlers) {
      const endpoint = await native.createWorker(module, options, handlers)
      return {
        terminate: () => endpoint.terminate(),
        postMessage(request) {
          sent.push(request)
          endpoint.postMessage(request)
        }
      }
    }
  }
}

async function create(adapter = artifactAdapter()) {
  const engine = await createMoeJS({ timeoutMs: 10_000, adapter })
  engines.push(engine)
  return engine
}

it("loads serialized linked cycles and dynamic imports without reparsing runtime source", async () => {
  const engine = await create()
  const a = await engine.compile(
    "a.js",
    `
    import { read } from "b"
    export function answer() { return 42 }
    export const result = read()
    // Exercise the guest dynamic loader rather than a static binding.
    export async function dynamic(name) { return (await import(name)).read() }
  `
  )
  const b = await engine.compile(
    "b.js",
    `
    import { answer } from "a"
    export function read() { return answer() }
  `
  )
  const linked = await engine.link(a, (_referrer, name) => (name === "a" ? a : b))
  const late = await engine.compile("late.js", "export function read() { return 43 }")
  for (let i = 0; i < 2; i++) {
    const runtime = await engine.newRuntime({
      importer: { resolve: (_referrer, name) => (name === "late" ? late : name === "a" ? a : b) }
    })
    await runtime.load(linked)
    expect(await runtime.get("result")).toBe(42)
    expect(await runtime.call(linked.hook("dynamic"), "b")).toBe(42)
    expect(await runtime.call(linked.hook("dynamic"), "late")).toBe(43)
  }
}, 30_000)

it("retains TypeScript scripts, direct eval scopes, source text and source locations", async () => {
  const engine = await create()
  const script = await engine.compileScriptWith(
    "scope.ts",
    `
    type Count = number;
    (() => {
      let count: Count = 40;
      class Counter {
        #value = 2;
        read() { return this.#value + eval("count") }
      }
      const template = (parts: TemplateStringsArray) => [parts[0], parts.raw[0]];
      return [new Counter().read(), template\`\\u{invalid}\`, "\\ud800"];
    })()
  `,
    { typeScript: true }
  )
  const runtime = await engine.newRuntime()
  expect(await runtime.runScript(script)).toEqual([42, [undefined, "\\u{invalid}"], "\ud800"])
  const module = await engine.compileTS(
    "original.ts",
    `
    export function read(value: number) { return eval("value + 1") }
    export function text() { return read.toString() }
    export function fail() { throw new Error("original source") }
  `
  )
  await runtime.load(module)
  expect(await runtime.call(module.hook("read"), 41)).toBe(42)
  expect(await runtime.call(module.hook("text"))).toContain("value: number")
  await expect(runtime.call(module.hook("fail"))).rejects.toMatchObject({
    message: "original source",
    stack: expect.stringContaining("original.ts")
  })
}, 30_000)

it("creates reusable sync, async, generator and async-generator function handles", async () => {
  const engine = await create()
  const sync = await engine.compileFunctionTS("add.ts", "a: number, b: number", "return a + b")
  const async = await engine.compileFunction(
    "async.js",
    "value",
    "return await Promise.resolve(value + 1)",
    { async: true }
  )
  const generator = await engine.compileFunction(
    "generator.js",
    "value",
    "yield value; return value + 1",
    { generator: true }
  )
  const asyncGenerator = await engine.compileFunctionTS(
    "async-generator.ts",
    "value: number",
    "yield await Promise.resolve(value)",
    { async: true, generator: true }
  )
  const runtime = await engine.newRuntime()
  const add = await runtime.runScriptValue(sync)
  expect(await add.call(undefined, 20, 22)).toBe(42)
  const increment = await runtime.runScriptValue(async)
  expect(await increment.call(undefined, 41)).toBe(42)
  for (const script of [generator, asyncGenerator]) {
    const fn = await runtime.runScriptValue(script)
    const iterator = await fn.callRaw(undefined, 42)
    const next = await iterator.get("next")
    expect(await next.call(iterator)).toEqual({ value: 42, done: false })
  }
}, 30_000)

it("rejects malformed artifact imports without poisoning the runtime", async () => {
  let corrupt = true
  const engine = await create(
    artifactAdapter((request) => {
      if (request.op !== "runScript" || !corrupt) return request
      corrupt = false
      return { ...request, payload: { ...request.payload, code: "AAAA" } }
    })
  )
  const script = await engine.compileScript("valid.js", "21 * 2")
  const runtime = await engine.newRuntime()
  await expect(runtime.runScript(script)).rejects.toThrow("bytecode artifact")
  expect(await runtime.runScript(script)).toBe(42)
}, 30_000)

it("sends each endpoint a module's or script's bytecode once", async () => {
  const sent: WorkerRequest[] = []
  const engine = await create(recordingAdapter(sent))
  type Bytecode = { code?: string; modules?: { code?: string }[] }
  const carried = (op: string) =>
    sent
      .filter((request) => request.op === op)
      .map(({ payload }) => {
        const { code, modules = [] } = payload as Bytecode
        return Boolean(code) || modules.some((module) => Boolean(module.code))
      })
  const dep = await engine.compile("dep.js", "export const base = 40")
  const entry = await engine.compile(
    "entry.js",
    'import { base } from "dep"\nexport const answer = () => base + 2'
  )
  const linked = await engine.link(entry, () => dep)
  const script = await engine.compileScript("script.js", "21 * 2")
  const runtime = await engine.newRuntime()
  await runtime.load(linked)
  expect(await runtime.call(linked.hook("answer"))).toBe(42)
  expect(await runtime.runScript(script)).toBe(42)
  expect(await runtime.runScript(script)).toBe(42)
  expect(carried("link")).toEqual([false])
  expect(carried("load")).toEqual([true])
  expect(carried("runScript")).toEqual([true, false])
  const late = await engine.compile("late.js", "export const v = 41")
  const importer = await engine.newRuntime({ importer: { resolve: () => late } })
  for (const name of ["first.js", "second.js"]) {
    const importing = await engine.compileScript(
      name,
      '(async () => (await import("late")).v + 1)()'
    )
    expect(await importer.runScript(importing)).toBe(42)
  }
  const replies = sent
    .filter((request) => request.op === "moduleResult")
    .map(({ payload }) => Boolean((payload as { module: Bytecode }).module.code))
  expect(replies).toEqual([true, false])
  const load = sent.find((request) => request.op === "load")!.payload as Bytecode
  expect([load.code, ...load.modules!.map((module) => module.code)].filter(Boolean)).toHaveLength(2)
}, 30_000)

it("compiles and loads modules beyond the former artifact item limit", async () => {
  const engine = await create()
  const source = Array.from(
    { length: 20_000 },
    (_, i) =>
      `export function f${i}(a, b) { const o = { k: a, v: b, s: "s${i}" }; ` +
      `for (let j = 0; j < 3; j++) o.k += j * ${i}; return [o.k, o.v, o.s].join("-") }`
  ).join("\n")
  const module = await engine.compile("wide.js", source, { maxSteps: 1e9 })
  const runtime = await engine.newRuntime()
  await runtime.load(module)
  expect(await runtime.call(module.hook("f19999"), 1, 2)).toBe("59998-2-s19999")
}, 60_000)

it("uses the runtime maxSteps convention for compile budgets", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  engines.push(engine)
  const source = Array.from({ length: 2_000 }, (_, i) => `export const v${i} = ${i}`).join("\n")
  await expect(engine.compile("limited.js", source, { maxSteps: 1 })).rejects.toMatchObject({
    kind: "budget"
  })
  for (const maxSteps of [0, -1]) {
    const module = await engine.compile("unlimited.js", source, { maxSteps })
    expect(module.exports).toHaveLength(2_000)
  }
  await expect(engine.compile("nan.js", source, { maxSteps: Number.NaN })).rejects.toThrow(
    RangeError
  )
  const script = await engine.compileScript("script.js", "21 * 2", { maxSteps: -1 })
  const fn = await engine.compileFunction("fn.js", "a", "return a", { maxSteps: -1 })
  const runtime = await engine.newRuntime()
  expect(await runtime.runScript(script)).toBe(42)
  expect(await (await runtime.runScriptValue(fn)).call(undefined, 7)).toBe(7)
}, 30_000)

function countingAdapter(posted: (op: string) => void) {
  const native = nodeAdapter()
  let workers = 0
  const adapter: Adapter = {
    loadModule: (url) => native.loadModule(url),
    async createWorker(module, options, handlers) {
      workers++
      const endpoint = await native.createWorker(module, options, handlers)
      return {
        terminate: () => endpoint.terminate(),
        postMessage(request) {
          endpoint.postMessage(request)
          posted(request.op)
        }
      }
    }
  }
  return { adapter, workers: () => workers }
}
const slowSource = "let x = 0;\n" + "x = x + 1;\n".repeat(400_000)

it("aborting an in-flight compile rejects only that compile and keeps siblings working", async () => {
  const controller = new AbortController()
  const reason = new Error("stop this compile")
  const { adapter } = countingAdapter((op) => {
    if (op === "compile" && armed) controller.abort(reason)
  })
  let armed = false
  const engine = await create(adapter)
  const dep = await engine.compile("dep.js", "export const v = 41")
  const entry = await engine.compile("entry.js", 'import { v } from "dep"\nexport const w = v + 1')
  armed = true
  const big = engine.compile("big.js", slowSource, { signal: controller.signal })
  armed = false
  const script = engine.compileScript("s.js", "1")
  const linked = engine.link(entry, () => dep)
  await expect(big).rejects.toBe(reason)
  expect((await script).name).toBe("s.js")
  expect((await linked).exports).toEqual(["w"])
  expect((await engine.compile("after.js", "export const a = 1")).exports).toEqual(["a"])
}, 30_000)

it("a compile timeout fails only that compile and does not replace the compiler", async () => {
  const { adapter, workers } = countingAdapter(() => {})
  const engine = await create(adapter)
  const before = workers()
  const slow = engine.compile("slow.js", "let x = 0;\n" + "x = x + 1;\n".repeat(1_500_000), {
    timeoutMs: 50
  })
  const queued = engine.compile("queued.js", "export const q = 1")
  await expect(slow).rejects.toMatchObject({
    kind: "timeout",
    name: "TimeoutError",
    code: "ERR_TIMEOUT",
    message: "MoeJS worker request exceeded 50ms"
  })
  expect((await queued).exports).toEqual(["q"])
  expect(workers()).toBe(before)
}, 60_000)

it("keeps a pre-aborted compile from being sent", async () => {
  const sent: WorkerRequest[] = []
  const engine = await create(recordingAdapter(sent))
  const reason = new Error("already aborted")
  await expect(
    engine.compile("never.js", "export const n = 1", { signal: AbortSignal.abort(reason) })
  ).rejects.toBe(reason)
  expect(sent.some((request) => request.op === "compile")).toBe(false)
}, 30_000)

it("does not give engine.link() an overall default deadline", async () => {
  const engine = await createMoeJS()
  engines.push(engine)
  const dep = await engine.compile("dep.js", "export const v = 1")
  const entry = await engine.compile("entry.js", 'import { v } from "dep"\nexport const w = v')
  const linked = await engine.link(entry, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return dep
  })
  expect(linked.exports).toEqual(["w"])
}, 30_000)
