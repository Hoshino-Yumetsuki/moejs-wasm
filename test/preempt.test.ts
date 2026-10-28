import { readFile } from "node:fs/promises"
import { afterEach, expect, it } from "vitest"
import { createMoeJS as createWasm } from "moejs-wasm/wasm"
import { createMoeJS, type Engine, type Hook, type Runtime, type RuntimeOptions } from "moejs-wasm"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})
const source = `
export function spin() { started(); for (;;) {} }
export function answer() { return 42 }
export function outer() { return outerHost() }
export function regex() { started(); return /^(?=(a+)+$)/.test("a".repeat(32) + "b") }
export function compile(kind) {
  const src = "let x = 0;\\n" + "x = (x + 1) | 0;\\n".repeat(1_000_000)
  started()
  return kind === "eval" ? (0, eval)(src) : Function(src)()
}
export const keep = []
export function grow(n) { for (let i = 0; i < n; i++) keep.push({ i }) }
export function chain(n) { let head = null; for (let i = 0; i < n; i++) head = { next: head }; keep.push(head) }
export function tick() { globalThis.ticks = 0; setInterval(() => globalThis.ticks++, 1) }
export function ticks() { return globalThis.ticks }
`
async function setup(options: RuntimeOptions = {}, create = createMoeJS) {
  const engine = await create({ timeoutMs: 60_000 })
  engines.push(engine)
  const mod = await engine.compile("preempt.js", source)
  const rt = await engine.newRuntime({ maxSteps: 0, maxDynamicSource: 64 << 20, ...options })
  let started = Promise.withResolvers<void>()
  await rt.setGlobal(
    "started",
    rt.function("started", 0, () => started.resolve())
  )
  await rt.load(mod)
  return {
    rt,
    hook: (name: string) => mod.hook(name),
    started: () => started.promise,
    reset: () => (started = Promise.withResolvers<void>())
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// The time from now until promise settles, in ms.
async function within(promise: Promise<unknown>): Promise<number> {
  const at = Date.now()
  await promise.then(
    () => undefined,
    () => undefined
  )
  return Date.now() - at
}
async function reusable(rt: Runtime, hook: (name: string) => Hook) {
  expect(await within(rt.clearInterrupt())).toBeLessThan(2000)
  expect(await rt.call(hook("answer"))).toBe(42)
}

it("preempts a CPU-bound loop and keeps the runtime reusable", async () => {
  const { rt, hook, started } = await setup()
  for (let i = 0; i < 2; i++) {
    rt.interrupt("idle")
    await rt.clearInterrupt()
  }
  const before = (await rt.stats()).Interrupts
  const call = rt.call(hook("spin"))
  const failure = expect(call).rejects.toMatchObject({ kind: "interrupted", reason: { token: 7 } })
  await started()
  await sleep(20)
  rt.interrupt({ token: 7 })
  expect(await within(call)).toBeLessThan(2000)
  await failure
  expect((await rt.stats()).Interrupts).toBe(before + 1)
  await reusable(rt, hook)
}, 30_000)

it("preempts through eventLoop.interrupt too", async () => {
  const { rt, hook, started } = await setup()
  const call = rt.call(hook("spin"))
  const failure = expect(call).rejects.toMatchObject({ kind: "interrupted" })
  await started()
  await sleep(20)
  await rt.eventLoop.interrupt("loop")
  expect(await within(call)).toBeLessThan(2000)
  await failure
  await reusable(rt, hook)
}, 30_000)

it("does not pre-reject queued calls: each settles when Go stops it", async () => {
  const { rt, hook, started } = await setup()
  const order: string[] = []
  const spin = rt.call(hook("spin")).catch((error: { kind: string }) => {
    order.push("spin")
    return error.kind
  })
  await started()
  const queued = rt.call(hook("answer")).catch((error: { kind: string }) => {
    order.push("queued")
    return error.kind
  })
  rt.interrupt("x")
  expect(await spin).toBe("interrupted")
  expect(await queued).toBe("interrupted")
  expect(order).toEqual(["spin", "queued"])
  await reusable(rt, hook)
}, 30_000)

it("preempts on a request timeout and rejects only the timed-out call", async () => {
  const { rt, hook } = await setup()
  await expect(rt.callWith(hook("spin"), [], { timeoutMs: 100 })).rejects.toMatchObject({
    kind: "interrupted",
    reason: { kind: "timeout" }
  })
  await reusable(rt, hook)
}, 30_000)

it("preempts regex backtracking", async () => {
  const { rt, hook, started } = await setup()
  const call = rt.call(hook("regex"))
  const failure = expect(call).rejects.toMatchObject({ kind: "interrupted", reason: "regex" })
  await started()
  await sleep(20)
  rt.interrupt("regex")
  expect(await within(call)).toBeLessThan(2000)
  await failure
  await reusable(rt, hook)
}, 30_000)

it.each(["Function", "eval", "evalScript"])(
  "preempts a dynamic compile via %s",
  async (kind) => {
    const { rt, hook, started } = await setup()
    const src = "let x = 0;\n" + "x = (x + 1) | 0;\n".repeat(1_000_000)
    const call =
      kind === "evalScript" ? rt.evalScript("big.js", src) : rt.call(hook("compile"), kind)
    const failure = expect(call).rejects.toMatchObject({ kind: "interrupted" })
    if (kind !== "evalScript") await started()
    await sleep(100)
    rt.interrupt("compile")
    expect(await within(call)).toBeLessThan(2000)
    await failure
    await reusable(rt, hook)
  },
  30_000
)

it("leaves a running loop running when no interrupt is pending", async () => {
  const { rt, hook } = await setup()
  await rt.call(hook("tick"))
  await rt.clearInterrupt()
  const at = (await rt.call<number>(hook("ticks"))) ?? 0
  for (let i = 0; i < 200 && (await rt.call<number>(hook("ticks"))) <= at; i++) await sleep(10)
  expect(await rt.call<number>(hook("ticks"))).toBeGreaterThan(at)
}, 30_000)

it("clears an interrupt from inside a runtime callback", async () => {
  const { rt, hook } = await setup()
  await rt.setGlobal(
    "started",
    rt.function("started", 0, async () => {
      rt.interrupt("a")
      await rt.clearInterrupt()
    })
  )
  await expect(rt.call(hook("spin"))).rejects.toMatchObject({ kind: "interrupted", reason: "a" })
  await rt.setGlobal(
    "started",
    rt.function("started", 0, () => undefined)
  )
  expect(await rt.call(hook("answer"))).toBe(42)
}, 30_000)

const wasm = readFile(new URL("../lib/moejs.wasm", import.meta.url))
it.each([
  ["worker", createMoeJS],
  [
    "current realm",
    async (options: { timeoutMs: number }) => createWasm({ ...options, wasm: await wasm })
  ]
] as const)(
  "ends a measurement an interrupt from its roots callback lands in, changing no counter (%s)",
  async (_, create) => {
    const { rt, hook } = await setup({ memoryLimit: 64 << 20 }, create as typeof createMoeJS)
    await rt.call(hook("chain"), 200_000)
    const before = await rt.stats()
    let called = false
    // MeasureLive always walks; a chain scans only 8 deep as reached, so drain still holds it after the roots.
    const partial = await rt.measureLive(() => {
      called = true
      rt.interrupt("stop walk")
    })
    const after = await rt.stats()
    expect(called).toBe(true)
    expect(after.LiveBytes).toBe(before.LiveBytes)
    expect(after.MemoryLimitHits).toBe(before.MemoryLimitHits)
    expect(after.Interrupts).toBe(before.Interrupts + 1)
    await rt.clearInterrupt()
    expect(await rt.measureLive()).toBeGreaterThan(partial + (1 << 20))
    expect(await rt.call(hook("answer"))).toBe(42)
  },
  30_000
)

it("preempts reentrant guest code that a sync host callback runs", async () => {
  const { rt, hook, started } = await setup()
  await rt.setGlobal(
    "outerHost",
    rt.function("outerHost", 0, () => rt.call(hook("spin")))
  )
  const call = rt.call(hook("outer"))
  const failure = expect(call).rejects.toMatchObject({ kind: "interrupted", reason: "nested" })
  await started()
  await sleep(20)
  rt.interrupt("nested")
  expect(await within(call)).toBeLessThan(2000)
  await failure
  await reusable(rt, hook)
}, 30_000)

it("defers a reentrant request that arrives while a reentrant dispatch is parked, in order", async () => {
  const { rt, hook, started } = await setup()
  const order: string[] = []
  const settle = (name: string, promise: Promise<unknown>) =>
    promise.then(
      () => order.push(`${name}:ok`),
      (error: { kind: string }) => order.push(`${name}:${error.kind}`)
    )
  let spin: Promise<unknown> | undefined
  await rt.setGlobal(
    "outerHost",
    rt.function("outerHost", 0, () => (spin = settle("spin", rt.call(hook("spin")))))
  )
  const call = rt.call(hook("outer")).catch((error: { kind: string }) => error.kind)
  await started()
  await sleep(20)
  // Still reentrant while outerHost waits; it reaches Go while spin runs, so it waits behind it.
  const answer = settle("answer", rt.call(hook("answer")))
  rt.interrupt("deferred")
  expect(await call).toBe("interrupted")
  await Promise.all([spin, answer])
  expect(order).toEqual(["spin:interrupted", "answer:interrupted"])
  await reusable(rt, hook)
}, 30_000)

it("resumes nested sync host waits innermost first when an interrupt fails them", async () => {
  const { rt, hook, started } = await setup()
  // The outer callback returns at once; its wait still resumes only after the spin it started ends.
  await rt.setGlobal(
    "outerHost",
    rt.function("outerHost", 0, () => {
      void rt.call(hook("spin")).catch(() => undefined)
      return 1
    })
  )
  const call = rt.call(hook("outer"))
  const failure = expect(call).rejects.toMatchObject({ kind: "interrupted" })
  await started()
  await sleep(20)
  rt.interrupt("lifo")
  expect(await within(call)).toBeLessThan(2000)
  await failure
  await reusable(rt, hook)
}, 30_000)
