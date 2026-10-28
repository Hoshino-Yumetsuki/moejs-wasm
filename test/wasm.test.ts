import { readFile } from "node:fs/promises"
import { createMoeJS as createNode } from "moejs-wasm/node"
import { createMoeJS } from "moejs-wasm/wasm"
import { expect, it } from "vitest"

it("loads the explicit Node entry without an adapter", async () => {
  const engine = await createNode({ timeoutMs: 5000 })
  try {
    const script = await engine.compileScript("node.js", "21 * 2")
    const runtime = await engine.newRuntime()
    expect(await runtime.runScript(script)).toBe(42)
  } finally {
    await engine.close()
  }
})

it("runs the portable WASM entry from bytes, a module and a response without Workers", async () => {
  const bytes = Uint8Array.from(await readFile(new URL("../lib/moejs.wasm", import.meta.url)))
  const sources = [bytes, await WebAssembly.compile(bytes), new Response(bytes)]
  for (const wasm of sources) {
    const engine = await createMoeJS({ wasm, timeoutMs: 5000 })
    try {
      const mod = await engine.compile(
        "portable.js",
        `
        export async function double(n) { return await host.double(n) }
        export const spin = () => { try { for (;;) {} } catch { return "escaped" } }
      `
      )
      const runtime = await engine.newRuntime({ maxSteps: 1000 })
      await runtime.setGlobal("host", { double: (n: unknown) => Number(n) * 2 })
      await runtime.load(mod)
      expect(await runtime.call(mod.hook("double"), 21)).toBe(42)
      await expect(runtime.call(mod.hook("spin"))).rejects.toMatchObject({
        kind: "interrupted",
        cause: { kind: "budget" }
      })
    } finally {
      await engine.close()
    }
  }
})

it("reports portable WASM download failures before starting an engine", async () => {
  await expect(createMoeJS({ wasm: new Response("not found", { status: 404 }) })).rejects.toThrow(
    "404"
  )
})

it("bounds an in-realm compile with timeoutMs", async () => {
  const wasm = Uint8Array.from(await readFile(new URL("../lib/moejs.wasm", import.meta.url)))
  const engine = await createMoeJS({ wasm })
  try {
    await expect(
      engine.compile("slow.js", "let x = 0;\n" + "x = x + 1;\n".repeat(1_500_000), {
        timeoutMs: 30
      })
    ).rejects.toMatchObject({ kind: "timeout", code: "ERR_TIMEOUT" })
    expect((await engine.compile("fast.js", "export const f = 1")).exports).toEqual(["f"])
  } finally {
    await engine.close()
  }
}, 60_000)

it("runs onError synchronously on the portable WASM entry", async () => {
  const wasm = Uint8Array.from(await readFile(new URL("../lib/moejs.wasm", import.meta.url)))
  const engine = await createMoeJS({ wasm })
  try {
    const mod = await engine.compile(
      "sync-error.js",
      `
      let seen
      export function run() {
        const done = Promise.withResolvers()
        setImmediate(() => { throw new Error("x") })
        setImmediate(() => { seen = globalThis.handled; done.resolve() })
        return done.promise.then(() => seen)
      }
    `
    )
    const rt = await engine.newRuntime({
      eventLoop: {
        async onError() {
          await rt.evalScript("mark.js", "globalThis.handled = true; undefined")
        }
      }
    })
    await rt.load(mod)
    expect(await rt.call(mod.hook("run"))).toBe(true)
  } finally {
    await engine.close()
  }
}, 30_000)

it("keeps handles strongly and still releases them without FinalizationRegistry", async () => {
  const script = `
    // Node's own fetch needs it, so load that first.
    void [fetch, Request, Response, Headers]
    delete globalThis.FinalizationRegistry
    const { createMoeJS } = await import(${JSON.stringify(new URL("../lib/node.mjs", import.meta.url).href)})
    const engine = await createMoeJS({ timeoutMs: 5000 })
    try {
      const rt = await engine.newRuntime()
      const value = await rt.evalScriptValue("v.js", "({ n: 1 })")
      const again = await rt.evalScriptValue("v.js", "globalThis.v ??= Symbol('s')")
      await rt.setGlobal("f", () => 2)
      const out = [await (await value.get("n")).toGo(), await rt.evalScript("f.js", "f()")]
      await value.release()
      await again.release()
      out.push(await rt.runScript(await engine.compileScript("s.js", "3")))
      console.log(JSON.stringify(out))
    } finally {
      await engine.close()
    }
  `
  const { execFile } = await import("node:child_process")
  const output = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  )
  expect(JSON.parse(output)).toEqual([1, 2, 3])
}, 30_000)

it("interrupts from a sync host callback in the current realm, settled by Go", async () => {
  const bytes = Uint8Array.from(await readFile(new URL("../lib/moejs.wasm", import.meta.url)))
  const engine = await createMoeJS({ wasm: bytes, timeoutMs: 5000 })
  try {
    const mod = await engine.compile(
      "in-realm.js",
      "export function spin() { host(); for (;;) {} }\nexport const answer = () => 42"
    )
    const rt = await engine.newRuntime({ maxSteps: 0 })
    await rt.setGlobal(
      "host",
      rt.function("host", 0, () => rt.interrupt("r"))
    )
    await rt.load(mod)
    await expect(rt.call(mod.hook("spin"))).rejects.toMatchObject({
      kind: "interrupted",
      reason: "r"
    })
    await rt.clearInterrupt()
    expect(await rt.call(mod.hook("answer"))).toBe(42)
  } finally {
    await engine.close()
  }
}, 30_000)
