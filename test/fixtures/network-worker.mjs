import { createMoeJS } from "moejs-wasm"

export default {
  async fetch() {
    const engine = await createMoeJS({ timeoutMs: 5000 })
    const sent = []
    const checked = []
    try {
      const mod = await engine.compile(
        "network-edge.js",
        `
        export async function text(url) { return (await fetch(url)).text() }
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
      return Response.json({ text, denied, sent, checked })
    } finally {
      await engine.close()
    }
  }
}
