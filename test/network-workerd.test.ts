import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { once } from "node:events"
import { deflateSync, gzipSync } from "node:zlib"
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
  const server = createServer((request, response) => {
    if (request.url === "/stream-echo") {
      let body = ""
      request.on("data", (chunk: Buffer) => (body += chunk.toString()))
      request.on("end", () =>
        response.end(JSON.stringify([body, request.headers["transfer-encoding"]]))
      )
    } else if (request.url === "/zlib") {
      response.writeHead(200, { "content-encoding": "deflate" })
      response.end(deflateSync("hello"))
    } else {
      response.writeHead(200, { "content-encoding": "gzip" })
      response.end(gzipSync("hello"))
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  const mf = new Miniflare({
    compatibilityDate: "2026-08-06",
    bindings: { BASE: `http://127.0.0.1:${port}` },
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
      checked: ["https://edge.test/ok", "https://edge.test/redirect", "https://denied.test/"],
      upload: ["p0p1p2", "chunked"],
      deflate: ["hello", "deflate"],
      gzip: ["hello", null]
    })
  } finally {
    await mf.dispose()
    server.close()
  }
}, 30_000)
