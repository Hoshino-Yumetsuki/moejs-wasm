// Run after `yarn build`: node bench/bench.mjs [--json out.json] [--filter name] [--adapter node|wasm] [--wasm file] [--huge]
import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"

const { values: flags } = parseArgs({
  options: {
    json: { type: "string" },
    filter: { type: "string" },
    adapter: { type: "string", default: "node" },
    wasm: { type: "string" },
    huge: { type: "boolean", default: false }
  }
})
const entry = flags.adapter === "wasm" ? "../lib/wasm.mjs" : "../lib/node.mjs"
const { createMoeJS } = await import(entry)
const wasmBytes =
  flags.adapter === "wasm"
    ? await WebAssembly.compile(
        await readFile(flags.wasm ?? new URL("../lib/moejs.wasm", import.meta.url))
      )
    : undefined
const create = (options = {}) =>
  createMoeJS({ timeoutMs: 120_000, ...options, ...(wasmBytes ? { wasm: wasmBytes } : {}) })

const results = []
function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
async function measure(name, { iterations, warmup = 1, ops = 1, selfTimed = false, check }, run) {
  if (flags.filter && !name.includes(flags.filter)) return
  for (let i = 0; i < warmup; i++) {
    const result = await run()
    check?.(result)
  }
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    const elapsed = await run()
    samples.push(selfTimed ? elapsed : performance.now() - start)
  }
  const ms = median(samples)
  const result = { name, ms: +ms.toFixed(3), perOpUs: +((ms * 1000) / ops).toFixed(2) }
  results.push(result)
  console.log(
    `${name.padEnd(34)} ${ms.toFixed(2).padStart(10)} ms` +
      (ops > 1 ? `  ${result.perOpUs.toFixed(2).padStart(9)} µs/op` : "")
  )
}

const records = Array.from({ length: 5000 }, (_, i) => ({
  id: i,
  name: `user-${i}`,
  active: i % 2 === 0,
  score: i * 1.5,
  tags: ["a", "b", "c"]
}))
const binary = new Uint8Array(1 << 20).map((_, i) => i & 255)
const text = "x".repeat(1 << 20)
const bigModule = Array.from(
  { length: 400 },
  (_, i) =>
    `export function f${i}(a, b) { const o = { k: a, v: b, s: "s${i}" }; ` +
    `for (let j = 0; j < 3; j++) o.k += j * ${i}; return [o.k, o.v, o.s].join("-") }`
).join("\n")
const guest = `
  export const noop = () => undefined
  export const add = (a, b) => a + b
  export const echo = (v) => v
  export const records = (n) => Array.from({ length: n }, (_, i) => ({
    id: i, name: "user-" + i, active: i % 2 === 0, score: i * 1.5, tags: ["a", "b", "c"]
  }))
  export const count = (v) => v.length
  let filled
  export const bytes = (n) => {
    if (filled?.length !== n) { filled = new Uint8Array(n); for (let i = 0; i < n; i++) filled[i] = i & 255 }
    return filled
  }
  export const byteLength = (b) => b.byteLength
  export const fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2)
  export function loop(n) { let s = 0; for (let i = 0; i < n; i++) s += i; return s }
  export async function asyncHost(n) { let s = 0; for (let i = 0; i < n; i++) s += await host.inc(i); return s }
  export function syncHost(n) { let s = 0; for (let i = 0; i < n; i++) s += host.incSync(i); return s }
`

const engine = await create()
try {
  await measure("startup: createMoeJS", { iterations: 5 }, async () => {
    await (await create()).close()
  })
  await measure("startup: newRuntime+close", { iterations: 10 }, async () => {
    await (await engine.newRuntime()).close()
  })
  if (!wasmBytes) {
    const warm = await create({ warmRuntimes: 1 })
    await measure(
      "startup: newRuntime+close (warm)",
      { iterations: 10, selfTimed: true },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        const start = performance.now()
        await (await warm.newRuntime()).close()
        return performance.now() - start
      }
    )
    await warm.close()
  }
  await measure("compile: small module", { iterations: 50, ops: 1 }, () =>
    engine.compile("small.js", "export const add = (a, b) => a + b")
  )
  await measure("compile: 400-function module", { iterations: 10 }, () =>
    engine.compile("big.js", bigModule)
  )
  const big = await engine.compile("big.js", bigModule)
  await measure("load: 400-function module", { iterations: 10, selfTimed: true }, async () => {
    const runtime = await engine.newRuntime()
    const start = performance.now()
    await runtime.load(big)
    const elapsed = performance.now() - start
    await runtime.close()
    return elapsed
  })

  const mod = await engine.compile("bench.js", guest)
  const rt = await engine.newRuntime({ maxSteps: 2_000_000_000, memoryLimit: 1 << 30 })
  await rt.setGlobal("host", {
    inc: (i) => i + 1,
    incSync: rt.function("incSync", 1, async (i) => (await i.export()) + 1)
  })
  await rt.load(mod)
  const hook = (name) => mod.hook(name)

  await measure("call: noop x1000", { iterations: 5, ops: 1000 }, async () => {
    for (let i = 0; i < 1000; i++) strictEqual(await rt.call(hook("noop")), undefined)
  })
  await measure("call: add(1,2) x1000", { iterations: 5, ops: 1000 }, async () => {
    for (let i = 0; i < 1000; i++) strictEqual(await rt.call(hook("add"), i, 2), i + 2)
  })
  await measure(
    "call: 100 concurrent",
    {
      iterations: 10,
      ops: 100,
      check: (sums) =>
        deepStrictEqual(
          sums,
          sums.map((_, i) => i + 2)
        )
    },
    () => Promise.all(Array.from({ length: 100 }, (_, i) => rt.call(hook("add"), i, 2)))
  )
  await measure(
    "host: async callback x500",
    { iterations: 5, ops: 500, check: (sum) => strictEqual(sum, 125250) },
    () => rt.call(hook("asyncHost"), 500)
  )
  await measure(
    "host: sync callback x500",
    { iterations: 5, ops: 500, check: (sum) => strictEqual(sum, 125250) },
    () => rt.call(hook("syncHost"), 500)
  )
  await measure("value: getValue+get+release x300", { iterations: 5, ops: 300 }, async () => {
    for (let i = 0; i < 300; i++) {
      const value = await rt.callValue(hook("echo"), { a: i })
      const field = await value.get("a")
      strictEqual(await field.export(), i)
      await field.release()
      await value.release()
    }
  })
  await measure(
    "data: 5000 records guest->host",
    { iterations: 10, check: (out) => deepStrictEqual(out, records) },
    () => rt.call(hook("records"), 5000)
  )
  await measure(
    "data: 5000 records host->guest",
    { iterations: 10, check: (n) => strictEqual(n, 5000) },
    () => rt.call(hook("count"), records)
  )
  await measure(
    "data: 5000 records echo",
    { iterations: 10, check: (out) => deepStrictEqual(out, records) },
    () => rt.call(hook("echo"), records)
  )
  await measure(
    "data: 1MB Uint8Array host->guest",
    { iterations: 10, check: (n) => strictEqual(n, 1 << 20) },
    () => rt.call(hook("byteLength"), binary)
  )
  await measure(
    "data: 1MB Uint8Array guest->host",
    { iterations: 10, check: (out) => deepStrictEqual(out, binary) },
    () => rt.call(hook("bytes"), 1 << 20)
  )
  await measure(
    "data: 1MB string echo",
    { iterations: 10, check: (out) => strictEqual(out, text) },
    () => rt.call(hook("echo"), text)
  )
  await measure("cpu: fib(22)", { iterations: 5, check: (n) => strictEqual(n, 17711) }, () =>
    rt.call(hook("fib"), 22)
  )
  await measure(
    "cpu: loop 1e6",
    { iterations: 5, check: (n) => strictEqual(n, 499999500000) },
    () => rt.call(hook("loop"), 1_000_000)
  )
  await rt.close()
  if (flags.huge) await hugeScenarios()
} finally {
  await engine.close()
}

async function hugeScenarios() {
  const unlimited = { maxSteps: 1e12, memoryLimit: 4 << 30 }
  const bundle = await readFile(
    new URL("../node_modules/typescript/lib/typescript.js", import.meta.url),
    "utf8"
  )
  let script
  await measure("huge: compileScript 9MB bundle", { iterations: 3 }, async () => {
    script = await engine.compileScript("typescript.js", bundle, { maxSteps: 1e12 })
  })
  const bundleRuntime = await engine.newRuntime(unlimited)
  await measure("huge: runScript 9MB bundle (first)", { iterations: 1, warmup: 0 }, () =>
    bundleRuntime.runScript(script)
  )
  await measure("huge: runScript 9MB bundle (again)", { iterations: 3 }, () =>
    bundleRuntime.runScript(script)
  )
  await measure(
    "huge: call into bundle",
    { iterations: 3, check: (version) => strictEqual(typeof version, "string") },
    () => bundleRuntime.evalScript("version.js", "ts.version")
  )
  await bundleRuntime.close()

  const functions = Array.from(
    { length: 20000 },
    (_, i) =>
      `export function f${i}(a, b) { const o = { k: a, v: b, s: "s${i}" }; ` +
      `for (let j = 0; j < 3; j++) o.k += j * ${i}; return [o.k, o.v, o.s].join("-") }`
  ).join("\n")
  let wide
  await measure("huge: compile 20k-export module", { iterations: 3 }, async () => {
    wide = await engine.compile("wide.js", functions, { maxSteps: 1e12 })
  })
  await measure("huge: load 20k-export module", { iterations: 3, selfTimed: true }, async () => {
    const runtime = await engine.newRuntime(unlimited)
    const start = performance.now()
    await runtime.load(wide)
    const elapsed = performance.now() - start
    strictEqual(await runtime.call(wide.hook("f19999"), 1, 2), "59998-2-s19999")
    await runtime.close()
    return elapsed
  })

  const chain = await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      engine.compile(
        `m${i}`,
        (i ? `import { v${i - 1} } from "m${i - 1}"\n` : "") +
          `export const v${i} = ${i ? `v${i - 1} + 1` : 0}\n` +
          Array.from({ length: 20 }, (_, j) => `export function g${j}() { return ${j} }`).join("\n")
      )
    )
  )
  const byName = new Map(chain.map((module, i) => [`m${i}`, module]))
  const resolve = (_referrer, specifier) => byName.get(specifier)
  let linked
  await measure("huge: link 500-module chain", { iterations: 3 }, async () => {
    linked = await engine.link(chain.at(-1), resolve)
  })
  await measure("huge: load 500-module chain", { iterations: 3, selfTimed: true }, async () => {
    const runtime = await engine.newRuntime()
    const start = performance.now()
    await runtime.load(linked)
    const elapsed = performance.now() - start
    strictEqual(await runtime.get("v499"), 499)
    await runtime.close()
    return elapsed
  })
  for (const [name, importer] of [
    ["huge: import 500-module chain", { resolve }],
    ["huge: import pre-linked 500-module chain", { resolve: () => linked }]
  ]) {
    await measure(name, { iterations: 3, selfTimed: true }, async () => {
      const runtime = await engine.newRuntime({ importer })
      const start = performance.now()
      const v = await runtime.evalScript("import.js", 'import("m499").then((ns) => ns.v499)')
      const elapsed = performance.now() - start
      strictEqual(v, 499)
      await runtime.close()
      return elapsed
    })
  }
}
if (flags.json) await writeFile(flags.json, JSON.stringify(results, null, 2))
