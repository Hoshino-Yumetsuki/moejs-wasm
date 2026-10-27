import { expect, it } from "vitest"
import { createMoeJS } from "moejs-wasm"

// These exercise Go WASM timers inside Workers; host fake timers cannot drive
// that clock. Await native completion signals rather than guessed host sleeps.

it("runs native timers, cancellation, interval arguments and top-level await", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const mod = await engine.compile(
      "timers.js",
      `
      const ready = Promise.withResolvers()
      setTimeout(ready.resolve, 1, 40)
      const initial = await ready.promise
      export async function run() {
        let cancelled = false
        const timeout = setTimeout(() => { cancelled = true }, 1)
        clearTimeout(timeout)
        const immediate = setImmediate(() => { cancelled = true })
        clearImmediate(immediate)
        const intervalGate = Promise.withResolvers()
        let count = 0
        const interval = setInterval((amount) => {
          count += amount
          if (count === 6) { clearInterval(interval); intervalGate.resolve(count) }
        }, 1, 2)
        const sum = await intervalGate.promise
        const immediateGate = Promise.withResolvers()
        setImmediate(immediateGate.resolve, initial + sum)
        const value = await immediateGate.promise
        return { value, cancelled }
      }
    `
    )
    const runtime = await engine.newRuntime()
    await runtime.load(mod)
    expect(await runtime.call(mod.hook("run"))).toEqual({ value: 46, cancelled: false })
  } finally {
    await engine.close()
  }
}, 30_000)

it("observes pending promises without reading guest constructors or species", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const mod = await engine.compile(
      "promise-observer.js",
      `
      export function run() {
        const { promise, resolve } = Promise.withResolvers()
        setTimeout(resolve, 1, 42)
        Object.defineProperty(promise, "constructor", {
          get() { throw new Error("host inspected guest constructor") }
        })
        return promise
      }
    `
    )
    const runtime = await engine.newRuntime()
    await runtime.load(mod)
    expect(await runtime.call(mod.hook("run"))).toBe(42)
  } finally {
    await engine.close()
  }
}, 30_000)

it("propagates uncaught timer errors and does not replenish execution fuel across timers", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const mod = await engine.compile(
      "timer-errors.js",
      `
      export function fail() {
        setTimeout(() => { throw new RangeError("timer failed") }, 1)
        return Promise.withResolvers().promise
      }
      export async function spin() {
        try { for (;;) {
          const { promise, resolve } = Promise.withResolvers()
          setTimeout(resolve, 1)
          await promise
        } }
        catch { return "escaped" }
      }
    `
    )
    const failing = await engine.newRuntime()
    await failing.load(mod)
    await expect(failing.call(mod.hook("fail"))).rejects.toMatchObject({
      name: "RangeError",
      message: "timer failed"
    })
    const limited = await engine.newRuntime({ maxSteps: 1000 })
    await limited.load(mod)
    await expect(limited.call(mod.hook("spin"))).rejects.toMatchObject({ kind: "budget" })
  } finally {
    await engine.close()
  }
}, 30_000)
