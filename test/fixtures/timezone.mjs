import { readFile } from "node:fs/promises"
import { createMoeJS } from "moejs-wasm/node"
import { createMoeJS as createPortable } from "moejs-wasm/wasm"

// The guest evaluates this function's source, and the host runs it directly.
function probeZone() {
  return JSON.stringify([
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    new Date(2026, 0, 15, 12).getTimezoneOffset(),
    new Date(2026, 6, 15, 12).getTimezoneOffset(),
    new Date(2026, 2, 8, 2, 30).getHours(),
    new Date(2026, 10, 1, 1, 30).getTime(),
    new Date("2026-07-04T12:00:00").getTime(),
    new Date(Date.UTC(2026, 6, 4, 16)).toLocaleString("en-US")
  ])
}
const parity = `(${probeZone.toString()})()`
const out = { host: JSON.parse(probeZone()) }
const probe = async (rt) => JSON.parse(await rt.evalScript("p.js", parity))
const engine = await createMoeJS({ timeoutMs: 10_000, warmRuntimes: 1 })
const wasm = await createPortable({
  wasm: await readFile(new URL("../../lib/moejs.wasm", import.meta.url))
})
try {
  const rt = await engine.newRuntime()
  out.node = await probe(rt)
  out.string = await rt.evalScript("s.js", "String(new Date(2026, 0, 15, 12))")
  await new Promise((resolve) => setTimeout(resolve, 200))
  out.warm = await probe(await engine.newRuntime())
  out.wasm = await probe(await wasm.newRuntime())
  out.local = await probe(await engine.newRuntime({ timeZone: "Local" }))
  const realm = await rt.realm()
  const ns = await rt.native("engine")
  await realm.invoke("SetTimeZone", await ns.invoke("LoadLocation", "Asia/Tokyo"))
  await realm.invoke("SetTimeZone", null)
  out.restored = await probe(rt)
} finally {
  await engine.close()
  await wasm.close()
}
console.log(JSON.stringify(out))
process.exit(0)
