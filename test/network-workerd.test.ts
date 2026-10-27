import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { rolldown } from "rolldown"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"

it("bridges host fetch and redirect policy in workerd without Node compatibility", async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL("./fixtures/network-worker.mjs", import.meta.url)),
    platform: "neutral",
    resolve: { conditionNames: ["workerd", "browser", "import"] },
    external: (id) => id.endsWith(".wasm")
  })
  let code: string
  try {
    const generated = await bundle.generate({
      format: "esm",
      codeSplitting: false,
      paths: (id) => (id.endsWith(".wasm") ? "./moejs.wasm" : id)
    })
    const entry = generated.output.find((output) => output.type === "chunk" && output.isEntry)
    if (!entry || entry.type !== "chunk") throw new Error("Workerd entry was not generated")
    code = entry.code
  } finally {
    await bundle.close()
  }
  const mf = new Miniflare({
    compatibilityDate: "2026-08-06",
    modules: [
      { type: "ESModule", path: "worker.mjs", contents: code },
      {
        type: "CompiledWasm",
        path: "moejs.wasm",
        contents: await readFile(new URL("../lib/moejs.wasm", import.meta.url))
      }
    ]
  })
  try {
    const response = await mf.dispatchFetch("https://moejs.invalid/")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      text: "edge fetch",
      denied: true,
      sent: ["https://edge.test/ok", "https://edge.test/redirect"],
      checked: ["https://edge.test/ok", "https://edge.test/redirect", "https://denied.test/"]
    })
  } finally {
    await mf.dispose()
  }
}, 30_000)
