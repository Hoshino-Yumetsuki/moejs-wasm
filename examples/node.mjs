import { createMoeJS } from "moejs-wasm"

const engine = await createMoeJS({ timeoutMs: 5000 })
try {
  const mod = await engine.compile(
    "plugin.js",
    `
    export async function buildRequest(task) {
      return {
        method: "POST",
        headers: { authorization: "Bearer " + await utils.env("API_KEY") },
        body: { prompt: task.prompt.trim(), n: task.n ?? 1 }
      }
    }
  `
  )
  const build = mod.hook("buildRequest")
  const rt = await engine.newRuntime({ memoryLimit: 8 * 1024 * 1024 })
  await rt.setGlobal("utils", { env: (name) => (name === "API_KEY" ? "test-key" : undefined) })
  await rt.load(mod)
  console.log(JSON.stringify(await rt.call(build, { prompt: " cat ", n: 2 }), null, 2))
} finally {
  await engine.close()
}
