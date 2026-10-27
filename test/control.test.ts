import { expect, it } from "vitest"
import { createMoeJS } from "moejs-wasm"

// Guest timers run inside Go WASM Workers, beyond host fake clocks. Tests
// await native loop idle or completion signals, never guessed host sleeps.

it("clears a budget interruption and reuses the same loaded module", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const module = await engine.compile(
      "recover.js",
      `
      export function spin() { for (;;) {} }
      export function answer() { return 42 }
    `
    )
    const runtime = await engine.newRuntime({ maxSteps: 1000 })
    await runtime.load(module)
    await expect(runtime.call(module.hook("spin"))).rejects.toMatchObject({ kind: "budget" })
    expect((await runtime.stats()).Interrupts).toBeGreaterThan(0)
    await runtime.resetAllocation()
    await runtime.releaseCallData()
    expect((await runtime.stats()).RequestAllocatedBytes).toBe(0)
    await expect(runtime.call(module.hook("answer"))).rejects.toMatchObject({ kind: "budget" })
    await runtime.clearInterrupt()
    expect(await runtime.call(module.hook("answer"))).toBe(42)
    runtime.interrupt("pause")
    await expect(runtime.call(module.hook("answer"))).rejects.toMatchObject({ kind: "interrupted" })
    await runtime.clearInterrupt()
    expect(await runtime.call(module.hook("answer"))).toBe(42)
  } finally {
    await engine.close()
  }
}, 30_000)

it("preserves paused timers, runs until idle, and permanently cancels terminated work", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const module = await engine.compile(
      "loop-control.js",
      `
      let count = 0
      export function schedule() { setTimeout(() => count++, 1) }
      export function read() { return count }
    `
    )
    const runtime = await engine.newRuntime()
    await runtime.load(module)
    await runtime.eventLoop.stop()
    await runtime.call(module.hook("schedule"))
    expect(await runtime.call(module.hook("read"))).toBe(0)
    await runtime.eventLoop.run()
    expect(await runtime.call(module.hook("read"))).toBe(1)
    await runtime.eventLoop.start()
    await runtime.eventLoop.stopNoWait()
    await runtime.eventLoop.stop()
    await runtime.call(module.hook("schedule"))
    await runtime.eventLoop.terminate()
    await runtime.clearInterrupt()
    expect(await runtime.call(module.hook("read"))).toBe(1)
    await expect(runtime.eventLoop.start()).rejects.toThrow()
    expect(await runtime.eventLoop.post(() => undefined)).toBe(false)
  } finally {
    await engine.close()
  }
}, 30_000)

it("queues host tasks and releases native holds while run waits", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const runtime = await engine.newRuntime()
    await runtime.eventLoop.stop()
    const release = await runtime.eventLoop.hold()
    const visited = Promise.withResolvers<void>()
    expect(await runtime.eventLoop.runOnLoop(() => visited.resolve())).toBe(true)
    const running = runtime.eventLoop.run()
    await visited.promise
    await release()
    await release()
    await running
  } finally {
    await engine.close()
  }
}, 30_000)

it("settles host-created Promises on the loop, including an externally awaited call", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const module = await engine.compile(
      "host-promise.js",
      `
      export async function consume(value) { return (await value) + 1 }
    `
    )
    const runtime = await engine.newRuntime()
    await runtime.load(module)
    const host = await runtime.newPromise()
    expect((await runtime.promiseState(host.promise)).state).toBe("pending")
    const result = runtime.call(module.hook("consume"), host.promise)
    await host.resolve(41)
    expect(await result).toBe(42)
    const fulfilled = await runtime.promiseState(host.promise)
    expect(fulfilled.state).toBe("fulfilled")
    expect(await fulfilled.result.toGo()).toBe(41)
    await runtime.eventLoop.stop()
    const paused = await runtime.newPromise()
    await paused.resolve(9)
    expect((await runtime.promiseState(paused.promise)).state).toBe("pending")
    await runtime.eventLoop.run()
    const resumed = await runtime.promiseState(paused.promise)
    expect(resumed.state).toBe("fulfilled")
    expect(await resumed.result.toGo()).toBe(9)
  } finally {
    await engine.close()
  }
}, 30_000)

it("reports an unhandled rejection and its later handler with the same Promise identity", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const module = await engine.compile(
      "rejection-tracker.js",
      `
      export function handle(value) { value.catch(() => {}) }
    `
    )
    const runtime = await engine.newRuntime()
    await runtime.load(module)
    const rejected = Promise.withResolvers<unknown>()
    const handled = Promise.withResolvers<unknown>()
    const operations: string[] = []
    await runtime.setPromiseRejectionTracker((event) => {
      operations.push(event.operation)
      if (event.operation === "reject") rejected.resolve(event.promise)
      else handled.resolve(event.promise)
    })
    const host = await runtime.newPromise()
    await host.reject("denied")
    expect(await rejected.promise).toBe(host.promise)
    const state = await runtime.promiseState(host.promise)
    expect(state.state).toBe("rejected")
    expect(await state.result.toGo()).toBe("denied")
    await runtime.call(module.hook("handle"), host.promise)
    expect(await handled.promise).toBe(host.promise)
    expect(operations).toEqual(["reject", "handle"])
    await runtime.setPromiseRejectionTracker(undefined)
  } finally {
    await engine.close()
  }
}, 30_000)

it("native OnError handles a failed callback and lets the next callback run", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const errors: string[] = []
    const runtime = await engine.newRuntime({
      eventLoop: { resetMemoryPerTask: true, onError: (error) => errors.push(error.message) }
    })
    const module = await engine.compile(
      "handled-timer.js",
      `
      export function run() {
        setImmediate(() => { throw new RangeError("handled timer") })
        const gate = Promise.withResolvers()
        setImmediate(gate.resolve, 42)
        return gate.promise
      }
    `
    )
    await runtime.load(module)
    expect(await runtime.call(module.hook("run"))).toBe(42)
    expect(errors).toEqual(["handled timer"])
  } finally {
    await engine.close()
  }
}, 30_000)

it("routes posted host task errors to OnError without rejecting a Promise", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const errors: string[] = []
    const rejections: string[] = []
    const visited: string[] = []
    const runtime = await engine.newRuntime({
      eventLoop: { onError: (error) => errors.push(error.message) },
      onPromiseRejection: (event) => rejections.push(event.operation)
    })
    await runtime.eventLoop.stop()
    expect(
      await runtime.eventLoop.post(() => {
        visited.push("failed")
        throw new Error("posted host task")
      })
    ).toBe(true)
    expect(await runtime.eventLoop.post(() => visited.push("next"))).toBe(true)
    await runtime.eventLoop.run()
    expect(errors).toEqual(["posted host task"])
    expect(visited).toEqual(["failed", "next"])
    expect(rejections).toEqual([])
  } finally {
    await engine.close()
  }
}, 30_000)

it.each(["host", "guest"] as const)(
  "stops on an unhandled posted %s task error and preserves the next task",
  async (source) => {
    const engine = await createMoeJS({ timeoutMs: 10_000 })
    try {
      const runtime = await engine.newRuntime()
      const module = await engine.compile(
        "posted-task.js",
        `export function task() { return () => { throw new Error("posted task failed") } }`
      )
      await runtime.load(module)
      await runtime.eventLoop.stop()
      const task =
        source === "guest"
          ? await runtime.callValue(module.hook("task"))
          : () => {
              throw new Error("posted task failed")
            }
      let nextRan = false
      expect(await runtime.eventLoop.post(task)).toBe(true)
      expect(
        await runtime.eventLoop.post(() => {
          nextRan = true
        })
      ).toBe(true)
      await expect(runtime.eventLoop.run()).rejects.toMatchObject({ message: "posted task failed" })
      expect(nextRan).toBe(false)
      await runtime.eventLoop.run()
      expect(nextRan).toBe(true)
    } finally {
      await engine.close()
    }
  },
  30_000
)

it.each(["post", "runOnLoop", "release"] as const)(
  "%s host tasks preserve promised callback completion",
  async (operation) => {
    const engine = await createMoeJS({ timeoutMs: 10_000 })
    const returned = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    try {
      const runtime = await engine.newRuntime()
      await runtime.eventLoop.stop()
      const visited: string[] = []
      const task = () => {
        visited.push("task")
        started.resolve()
        return returned.promise
      }
      if (operation === "release") {
        const release = await runtime.eventLoop.hold()
        await release(task)
      } else {
        expect(await runtime.eventLoop[operation](task)).toBe(true)
      }
      expect(await runtime.eventLoop.post(() => visited.push("next"))).toBe(true)
      const running = runtime.eventLoop.run()
      await started.promise
      expect(visited).toEqual(["task"])
      returned.resolve()
      await running
      expect(visited).toEqual(["task", "next"])
    } finally {
      returned.resolve()
      await engine.close()
    }
  },
  30_000
)

it("ResetMemoryPerTask resets the allocation budget rather than rebasing retained data", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const module = await engine.compile(
      "task-budgets.js",
      `
      const retained = []
      export async function accumulate() {
        for (let i = 0; i < 40; i++) {
          const gate = Promise.withResolvers()
          setImmediate(() => {
            // Incremental array growth hits the memory interrupt, unlike the
            // catchable size precheck used by typed-array constructors.
            const values = []
            retained.push(values)
            for (let j = 0; j < 500; j++) values.push(i * 500 + j)
            gate.resolve()
          })
          await gate.promise
        }
        return retained.reduce((sum, values) =>
          values.reduce((sum, value) => sum + value, sum), 0)
      }
    `
    )
    const runtime = await engine.newRuntime({
      memoryLimit: 100_000,
      eventLoop: { resetMemoryPerTask: true }
    })
    await runtime.load(module)
    expect(await runtime.call(module.hook("accumulate"))).toBe(199_990_000)
    const bounded = await engine.newRuntime({ memoryLimit: 100_000 })
    await bounded.load(module)
    await expect(bounded.call(module.hook("accumulate"))).rejects.toMatchObject({ kind: "memory" })
  } finally {
    await engine.close()
  }
}, 30_000)

it("rebasing counts values retained only by host references", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const module = await engine.compile(
      "host-roots.js",
      `
      export function allocate() { return new Uint8Array(1_200_000) }
    `
    )
    const runtime = await engine.newRuntime({ memoryLimit: 2_000_000 })
    await runtime.load(module)
    await runtime.eventLoop.stop()
    const retained = await runtime.callValue(module.hook("allocate"))
    await runtime.releaseCallData()
    await runtime.rebaseAllocation()
    const first = await runtime.stats()
    expect(first.LiveBytes).toBeGreaterThanOrEqual(1_200_000)
    expect(await (await retained.get("byteLength")).toGo()).toBe(1_200_000)
    await retained.release()
  } finally {
    await engine.close()
  }
}, 30_000)

it.each(["runtime", "event loop"] as const)(
  "interrupts a suspended synchronous host function through %s while stop waits, then reuses the runtime",
  async (source) => {
    const engine = await createMoeJS({ timeoutMs: 10_000 })
    const started = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<never>()
    try {
      const runtime = await engine.newRuntime()
      await runtime.setGlobal(
        "blocked",
        runtime.function("blocked", 0, () => {
          started.resolve()
          return blocked.promise
        })
      )
      const module = await engine.compile(
        "sync-interrupt.js",
        `
      export function wait() { return blocked() }
      export function answer() { return 42 }
    `
      )
      await runtime.load(module)
      const pending = expect(runtime.call(module.hook("wait"))).rejects.toMatchObject({
        kind: "interrupted"
      })
      await started.promise
      const stopping = runtime.eventLoop.stop().catch(() => undefined)
      if (source === "runtime") runtime.interrupt("cancel synchronous host")
      else await runtime.eventLoop.interrupt("cancel synchronous host")
      await pending
      await stopping
      await runtime.clearInterrupt()
      await runtime.eventLoop.start()
      expect(await runtime.call(module.hook("answer"))).toBe(42)
    } finally {
      await engine.close()
    }
  },
  30_000
)
