import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import { createMoeJS, type Engine } from "moejs-wasm"

const run = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/timezone.mjs", import.meta.url))
async function inZone(TZ: string) {
  const { stdout } = await run(process.execPath, [fixture], {
    env: { ...process.env, TZ },
    timeout: 30_000
  })
  return JSON.parse(stdout) as Record<string, unknown[]> & { string: string }
}

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})

it("follows the host zone with DST rules, as time.Local does for $TZ", async () => {
  const out = await inZone("America/New_York")
  expect(out.host!.slice(0, 3)).toEqual(["America/New_York", 300, 240])
  for (const name of ["node", "warm", "wasm", "local", "restored"])
    expect(out[name]).toEqual(out.host)
  expect(out.string).toBe("Thu Jan 15 2026 12:00:00 GMT-0500 (EST)")
  const utc = await inZone("UTC")
  expect(utc.node!.slice(0, 3)).toEqual(["UTC", 0, 0])
  expect(utc.string.endsWith("GMT+0000 (UTC)")).toBe(true)
}, 60_000)

it("maps timeZone strings like time.LoadLocation and builds FixedZone natively", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  engines.push(engine)
  const utc = await engine.newRuntime({ timeZone: "" })
  expect(
    await utc.evalScript(
      "u.js",
      "[Intl.DateTimeFormat().resolvedOptions().timeZone, new Date(2026, 6, 1).getTimezoneOffset()]"
    )
  ).toEqual(["UTC", 0])
  await expect(engine.newRuntime({ timeZone: "Nope/Zone" })).rejects.toMatchObject({
    kind: "bridge",
    message: "unknown time zone Nope/Zone"
  })
  await expect(engine.newRuntime({ timeZone: "+05:30" })).rejects.toMatchObject({
    message: "unknown time zone +05:30"
  })
  const rt = await engine.newRuntime()
  const ns = await rt.native("engine")
  await expect(ns.invoke("LoadLocation", "Nope/Zone")).rejects.toThrow(
    "unknown time zone Nope/Zone"
  )
  await (await rt.realm()).invoke("SetTimeZone", await ns.invoke("FixedZone", "IST", 19800))
  expect(
    await rt.evalScript(
      "f.js",
      "[new Date(0).getTimezoneOffset(), Intl.DateTimeFormat().resolvedOptions().timeZone, String(new Date(0))]"
    )
  ).toEqual([-330, "+05:30", "Thu Jan 01 1970 05:30:00 GMT+0530 (IST)"])
}, 30_000)
