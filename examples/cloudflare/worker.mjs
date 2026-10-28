import { createMoeJS } from "moejs-wasm"

export default {
  async fetch() {
    const engine = await createMoeJS({ timeoutMs: 5000 })
    try {
      const dependency = await engine.compile("dep.js", "export const value = 40")
      const lazy = await engine.compile("lazy.js", "export const value = 2")
      const mod = await engine.compile(
        "edge.js",
        `
        import { value } from "dependency"
        export async function greet(name) { return await host.prefix() + name }
        export function spin() { try { for (;;) {} } catch { return "escaped" } }
        export function capabilities() { return [typeof process, typeof WebAssembly] }
        export async function native() {
          const { promise, resolve } = Promise.withResolvers()
          setTimeout(resolve, 1)
          await promise
          const lazy = await import("lazy")
          const response = new Response(new Uint8Array([value + lazy.value]))
          const reader = response.body.getReader()
          const chunk = await reader.read()
          await reader.cancel()
          return { value: chunk.value[0], host: new URL("https://example.test/path").host, url: import.meta.url }
        }
      `
      )
      const linked = await engine.link(mod, () => dependency)
      const runtime = await engine.newRuntime({
        maxSteps: 10_000,
        importer: {
          resolve: (_referrer, specifier) => {
            if (specifier !== "lazy") throw new Error(`Module not allowed: ${specifier}`)
            return lazy
          },
          meta: (module) => ({ url: module.name })
        }
      })
      await runtime.setGlobal("host", { prefix: async () => "Hello, " })
      await runtime.load(linked)
      const greeting = await runtime.call(linked.hook("greet"), "Cloudflare")
      const capabilities = await runtime.call(linked.hook("capabilities"))
      const native = await runtime.call(linked.hook("native"))
      let exhaustion
      try {
        await runtime.call(linked.hook("spin"))
      } catch (error) {
        exhaustion = error.cause?.kind
      }
      return Response.json({ greeting, capabilities, native, exhaustion })
    } finally {
      await engine.close()
    }
  }
}
