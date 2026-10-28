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
      host.loaded()
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
    const loaded = Promise.withResolvers<void>()
    await runtime.setGlobal("host", { loaded: () => loaded.resolve() })
    await expect(runtime.load(mod)).rejects.toMatchObject({ code: "ERR_MODULE_PENDING" })
    await loaded.promise
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

it("propagates uncaught timer errors", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const mod = await engine.compile(
      "timer-errors.js",
      `
      export function fail() {
        setTimeout(() => { throw new RangeError("timer failed") }, 1)
        return Promise.withResolvers().promise
      }
    `
    )
    const failing = await engine.newRuntime()
    await failing.load(mod)
    await expect(failing.call(mod.hook("fail"))).rejects.toMatchObject({
      name: "RangeError",
      message: "timer failed"
    })
  } finally {
    await engine.close()
  }
}, 30_000)

it("gives every timer, immediate and interval callback a fresh step budget", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const mod = await engine.compile(
      "timer-budget.js",
      `
      function burn() { let t = 0; for (let i = 0; i < 500; i++) t += i; return t }
      export async function timers(n) { for (let i = 0; i < n; i++) { const g = Promise.withResolvers(); setTimeout(() => g.resolve(burn()), 1); await g.promise } return n }
      export async function immediates(n) { for (let i = 0; i < n; i++) { const g = Promise.withResolvers(); setImmediate(() => g.resolve(burn())); await g.promise } return n }
      export function interval(n) { const g = Promise.withResolvers(); let k = 0; const id = setInterval(() => { burn(); if (++k === n) { clearInterval(id); g.resolve(k) } }, 1); return g.promise }
      export function runaway() { setTimeout(() => { for (;;) {} }, 1); return Promise.withResolvers().promise }
      export function burnAll(n) { for (let i = 0; i < n; i++) burn(); return n }
    `
    )
    const runtime = await engine.newRuntime({ maxSteps: 10_000 })
    await runtime.load(mod)
    await expect(runtime.call(mod.hook("burnAll"), 50)).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "budget" }
    })
    await runtime.clearInterrupt()
    await runtime.eventLoop.start()
    expect(await runtime.call(mod.hook("timers"), 50)).toBe(50)
    expect(await runtime.call(mod.hook("immediates"), 50)).toBe(50)
    expect(await runtime.call(mod.hook("interval"), 50)).toBe(50)
    await expect(runtime.call(mod.hook("runaway"))).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "budget" }
    })
  } finally {
    await engine.close()
  }
}, 30_000)

it("refills the step budget for timers that resume after clearInterrupt", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const mod = await engine.compile(
      "resume-budget.js",
      `
      let fired = false
      export function arm() { setTimeout(() => { fired = true }, 200); setTimeout(() => { for (;;) {} }, 1); return Promise.withResolvers().promise }
      export function wasFired() { return fired }
    `
    )
    const runtime = await engine.newRuntime({ maxSteps: 1000 })
    await runtime.load(mod)
    await expect(runtime.call(mod.hook("arm"))).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "budget" }
    })
    await runtime.clearInterrupt()
    await runtime.eventLoop.run()
    expect(await runtime.call(mod.hook("wasFired"))).toBe(true)
  } finally {
    await engine.close()
  }
}, 30_000)

it("runs the event loop without a default deadline unless one is set", async () => {
  const engine = await createMoeJS()
  try {
    const mod = await engine.compile(
      "long-run.js",
      `
      let fired = false
      export function arm(ms) { setTimeout(() => { fired = true }, ms) }
      export function wasFired() { return fired }
    `
    )
    const runtime = await engine.newRuntime()
    await runtime.load(mod)
    await runtime.eventLoop.stop()
    await runtime.call(mod.hook("arm"), 1200)
    await runtime.eventLoop.run()
    expect(await runtime.call(mod.hook("wasFired"))).toBe(true)
    await runtime.call(mod.hook("arm"), 60_000)
    await expect(runtime.eventLoop.run({ timeoutMs: 50 })).rejects.toMatchObject({
      kind: "interrupted",
      cause: { kind: "timeout" }
    })
  } finally {
    await engine.close()
  }
}, 30_000)
