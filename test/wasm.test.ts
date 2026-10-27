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
      await expect(runtime.call(mod.hook("spin"))).rejects.toMatchObject({ kind: "budget" })
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
