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
    const runtime = await engine.newRuntime({ importer: { resolve: () => late } })
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
