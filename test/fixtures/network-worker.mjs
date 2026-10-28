import { createMoeJS } from "moejs-wasm"

export default {
  async fetch(_request, env) {
    const engine = await createMoeJS({ timeoutMs: 5000 })
    const sent = []
    const checked = []
    try {
      const mod = await engine.compile(
        "network-edge.js",
        `
        export async function text(url) { return (await fetch(url)).text() }
        export async function decoded(url, headers) {
          const r = await fetch(url, { headers })
          return [await r.text(), r.headers.get("content-encoding")]
        }
        export async function stream(url) {
          let i = 0
          const body = new ReadableStream({ pull(c) { if (i < 3) c.enqueue(new TextEncoder().encode("p" + i++)); else c.close() } })
          return (await fetch(url, { method: "POST", body, duplex: "half" })).json()
        }
      `
      )
      const runtime = await engine.newRuntime({
        network: {
          allow: async ({ url }) => {
            checked.push(url)
            return new URL(url).hostname === "edge.test"
          },
          fetch: async (input, init) => {
            if (init.redirect !== "manual" || init.credentials !== "omit") {
              throw new Error("Unsafe host fetch options")
            }
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            sent.push(url)
            if (url.endsWith("/redirect")) {
              return new Response(null, {
                status: 302,
                headers: { location: "https://denied.test/" }
              })
            }
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("edge fetch"))
                  controller.close()
                }
              })
            )
          }
        }
      })
      await runtime.load(mod)
      const text = await runtime.call(mod.hook("text"), "https://edge.test/ok")
      let denied = false
      try {
        await runtime.call(mod.hook("text"), "https://edge.test/redirect")
      } catch (error) {
        denied = error.name === "TypeError"
      }
      const local = await engine.newRuntime({ network: { allowHosts: ["127.0.0.1"] } })
      await local.load(mod)
      const upload = await local.call(mod.hook("stream"), `${env.BASE}/stream-echo`)
      const deflate = await local.call(mod.hook("decoded"), `${env.BASE}/zlib`, {
        "accept-encoding": "deflate"
      })
      const gzip = await local.call(mod.hook("decoded"), `${env.BASE}/gzip`)
      return Response.json({ text, denied, sent, checked, upload, deflate, gzip })
    } finally {
      await engine.close()
    }
  }
}
