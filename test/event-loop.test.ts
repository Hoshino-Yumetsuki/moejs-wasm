import { afterEach, expect, it } from "vitest"
import {
  createMoeJS,
  MoeJSError,
  type Engine,
  type EventLoopOptions,
  type PromiseRejectionEvent,
  type Value
} from "moejs-wasm"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})
async function setup(source: string, options: Parameters<Engine["newRuntime"]>[0] = {}) {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  engines.push(engine)
  const mod = await engine.compile("loop.js", source)
  const rt = await engine.newRuntime(options)
  await rt.load(mod)
  return { engine, rt, mod, hook: (name: string) => mod.hook(name) }
}

it("onError receives a MoeJSError whose value is a live guest Value", async () => {
  let stashed: Value | undefined
  const seen: unknown[] = []
  const eventLoop: EventLoopOptions = {
    async onError(error) {
      seen.push(error instanceof MoeJSError, error.kind, error.name)
      const value = error.value as Value
      seen.push(await (await value.get("message")).toGo())
      seen.push((await rt.thrownValue(error)).value === value)
      stashed = value
    }
  }
  const { rt, hook } = await setup(
    `
    export function fail() {
      const done = Promise.withResolvers()
      setImmediate(() => { throw new RangeError("handled") })
      setTimeout(done.resolve, 5)
      return done.promise
    }
  `,
    { eventLoop }
  )
  await rt.call(hook("fail"))
  expect(seen).toEqual([true, "exception", "RangeError", "handled", true])
  expect(await (await stashed!.get("message")).export()).toBe("handled")
}, 30_000)

it("onError runs synchronously on the loop before the next callback", async () => {
  const { rt, hook } = await setup(
    `
    let seen
    export function run() {
      const done = Promise.withResolvers()
      setImmediate(() => { throw new Error("x") })
      setImmediate(() => { seen = globalThis.handled; done.resolve() })
      return done.promise.then(() => seen)
    }
  `,
    {
      eventLoop: {
        async onError() {
          await rt.evalScript("mark.js", "globalThis.handled = true; undefined")
        }
      }
    }
  )
  expect(await rt.call(hook("run"))).toBe(true)
}, 30_000)

it("onError can stopNoWait the loop and the next immediate stays queued", async () => {
  const { rt, hook } = await setup(
    `
    let count = 0
    export function schedule() { setImmediate(() => { throw new Error("x") }); setImmediate(() => { count++ }) }
    export function read() { return count }
  `,
    {
      eventLoop: {
        async onError() {
          await rt.eventLoop.stopNoWait()
        }
      }
    }
  )
  await rt.eventLoop.stop()
  await rt.call(hook("schedule"))
  await rt.eventLoop.run()
  expect(await rt.call(hook("read"))).toBe(0)
  await rt.eventLoop.run()
  expect(await rt.call(hook("read"))).toBe(1)
}, 30_000)

it("handled loop errors do not pin their values", async () => {
  const { rt, hook } = await setup(
    "export function schedule() { for (let i = 0; i < 200; i++) setImmediate(() => { throw { payload: new Uint8Array(50_000) } }) }",
    { memoryLimit: 4_000_000, eventLoop: { onError: () => {} } }
  )
  await rt.eventLoop.stop()
  await rt.call(hook("schedule"))
  await rt.eventLoop.run()
  await rt.rebaseAllocation()
  expect((await rt.stats()).LiveBytes).toBeLessThan(1_000_000)
}, 30_000)

it("a value the host already holds survives delivery to onError, and a throwing onError is ignored", async () => {
  const errors: unknown[] = []
  const { rt, hook } = await setup(
    "export function throwLater(v) { setImmediate(() => { throw v }); setImmediate(() => { throw v }) }",
    {
      eventLoop: {
        onError(error) {
          errors.push(error.value)
          if (errors.length === 1) throw new Error("handler bug")
        }
      }
    }
  )
  const held = await rt.fromHost({ tag: 1 })
  await rt.eventLoop.stop()
  await rt.call(hook("throwLater"), held)
  await rt.eventLoop.run()
  expect(errors).toEqual([held, held])
  expect(await (await held.get("tag")).toGo()).toBe(1)
}, 30_000)

it("EventTarget and AbortSignal listener errors reach onError, or stop the loop without it", async () => {
  const source = `
    export function fire() {
      const t = new EventTarget()
      t.addEventListener("x", () => { throw new TypeError("listener") })
      t.dispatchEvent(new Event("x"))
      return "dispatched"
    }
    export function abortListener() {
      const s = AbortSignal.timeout(1)
      s.addEventListener("abort", () => { throw new Error("abort listener") })
      setTimeout(() => {}, 20)
    }
    let followed = false
    export function follow() { followed = true }
    export function followedUp() { return followed }
  `
  const messages: string[] = []
  const handled = await setup(source, {
    eventLoop: {
      async onError(error) {
        const message = String(await (await (error.value as Value).get("message")).toGo())
        messages.push(`${error.kind}:${error.name}:${message}`)
      }
    }
  })
  expect(await handled.rt.call(handled.hook("fire"))).toBe("dispatched")
  await handled.rt.eventLoop.stop()
  await handled.rt.call(handled.hook("abortListener"))
  await handled.rt.eventLoop.run()
  expect(messages).toEqual(["exception:TypeError:listener", "exception:Error:abort listener"])
  const bare = await setup(source)
  await bare.rt.eventLoop.stop()
  await bare.rt.call(bare.hook("fire"))
  await bare.rt.eventLoop.post(await bare.rt.getValue("follow"))
  await expect(bare.rt.eventLoop.run()).rejects.toMatchObject({
    name: "TypeError",
    message: "listener"
  })
  expect(await bare.rt.call(bare.hook("followedUp"))).toBe(false)
  await bare.rt.eventLoop.run()
  expect(await bare.rt.call(bare.hook("followedUp"))).toBe(true)
}, 30_000)

it("the rejection tracker runs synchronously inside the rejecting operation", async () => {
  const events: string[] = []
  const tracker = async (event: PromiseRejectionEvent) => {
    events.push(`${event.operation}:${event.state}:${(await rt.promiseState(event.promise)).state}`)
    await rt.evalScript("t.js", "globalThis.marked = (globalThis.marked ?? 0) + 1; undefined")
  }
  const { rt, hook } = await setup(
    "export function probe() { Promise.reject(1); return globalThis.marked }",
    { onPromiseRejection: tracker }
  )
  expect(await rt.call(hook("probe"))).toBe(1)
  expect(events).toEqual(["reject:rejected:rejected"])
  await rt.setPromiseRejectionTracker(undefined)
  await rt.call(hook("probe"))
  expect(events).toHaveLength(1)
}, 30_000)

it("runOnLoop and post without a task report liveness; host tasks receive the runtime", async () => {
  const errors: unknown[] = []
  const { rt } = await setup("export const x = 1", {
    eventLoop: { onError: (e) => errors.push(e) }
  })
  expect(await rt.eventLoop.runOnLoop()).toBe(true)
  expect(await rt.eventLoop.post()).toBe(true)
  await rt.eventLoop.stop()
  const seen: boolean[] = []
  await rt.eventLoop.post((r) => seen.push(r === rt))
  await rt.eventLoop.runOnLoop((r) => seen.push(r === rt))
  await rt.eventLoop.runOnLoop(() => {
    throw new Error("dropped")
  })
  const release = await rt.eventLoop.hold()
  await release((r) => seen.push(r === rt))
  await rt.eventLoop.run()
  expect(seen).toEqual([true, true, true])
  expect(errors).toEqual([])
  await rt.eventLoop.terminate()
  expect(await rt.eventLoop.runOnLoop()).toBe(false)
  expect(await rt.eventLoop.post()).toBe(false)
  let ran = false
  const late = await rt.eventLoop.hold()
  await late(() => {
    ran = true
  })
  expect(ran).toBe(false)
}, 30_000)

it("loop promises settle on the loop, hold run(), and are quiet after terminate", async () => {
  const { rt } = await setup("export const x = 1")
  await rt.eventLoop.stop()
  const order: boolean[] = []
  const computed = await rt.eventLoop.newPromise()
  await computed.settle((r) => {
    order.push(r === rt)
    return 7
  })
  expect((await rt.promiseState(computed.promise)).state).toBe("pending")
  const failed = await rt.eventLoop.newPromise()
  await failed.settle(() => {
    throw new TypeError("nope")
  })
  await rt.eventLoop.run()
  const fulfilled = await rt.promiseState(computed.promise)
  expect([fulfilled.state, await fulfilled.result.toGo(), order]).toEqual(["fulfilled", 7, [true]])
  const rejected = await rt.promiseState(failed.promise)
  expect(rejected.state).toBe("rejected")
  expect(await (await rejected.result.get("message")).toGo()).toBe("nope")
  const holding = await rt.eventLoop.newPromise()
  let done = false
  const running = rt.eventLoop.run().then(() => (done = true))
  await rt.stats()
  expect(done).toBe(false)
  await holding.resolve(1)
  await running
  const pending = await rt.eventLoop.newPromise()
  await rt.eventLoop.terminate()
  await pending.resolve(1)
  const late = await rt.eventLoop.newPromise()
  await late.settle(() => 1)
  expect((await rt.promiseState(late.promise)).state).toBe("pending")
}, 30_000)

it("an interrupt during settle(fn) leaves the promise pending and stops the loop", async () => {
  const { rt } = await setup("export const x = 1")
  await rt.eventLoop.stop()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const lp = await rt.eventLoop.newPromise()
  await lp.settle(() => {
    entered.resolve()
    return gate.promise
  })
  const running = rt.eventLoop.run()
  await entered.promise
  rt.interrupt("x")
  await expect(running).rejects.toMatchObject({ kind: "interrupted" })
  gate.resolve()
  await rt.clearInterrupt()
  expect((await rt.promiseState(lp.promise)).state).toBe("pending")
}, 30_000)

it("rt.newPromise settles at once without the loop, runs its jobs and does not hold run()", async () => {
  const { rt, hook } = await setup(`
    export function watch(v) { v.then((x) => { globalThis.seen = x }) }
    export function hook(v) { v.then(() => queueMicrotask(() => { throw new Error("job") })) }
  `)
  await rt.eventLoop.stop()
  const p = await rt.newPromise()
  await rt.call(hook("watch"), p.promise)
  await p.resolve(5)
  await p.reject(2)
  const state = await rt.promiseState(p.promise)
  expect([state.state, await state.result.toGo()]).toEqual(["fulfilled", 5])
  expect(await rt.evalScript("s.js", "globalThis.seen")).toBe(5)
  const failing = await rt.newPromise()
  await rt.call(hook("hook"), failing.promise)
  await expect(failing.resolve(1)).rejects.toMatchObject({ message: "job" })
  expect((await rt.promiseState(failing.promise)).state).toBe("fulfilled")
  await rt.newPromise()
  await rt.eventLoop.run()
}, 30_000)

it("run(fn) calls fn first, and rejects with its error leaving the loop's work pending", async () => {
  const order: string[] = []
  const { rt, hook } = await setup(`
    export function schedule() { setTimeout(() => push("timer"), 1) }
  `)
  await rt.setGlobal(
    "push",
    rt.function("push", 1, async (item) => {
      order.push(String(await (item as Value).toGo()))
    })
  )
  await rt.eventLoop.stop()
  await rt.call(hook("schedule"))
  await rt.eventLoop.run(() => {
    order.push("fn")
  })
  expect(order).toEqual(["fn", "timer"])
  await rt.call(hook("schedule"))
  await expect(
    rt.eventLoop.run(() => {
      throw new Error("fn")
    })
  ).rejects.toMatchObject({ message: "fn" })
  expect(order).toEqual(["fn", "timer"])
  await rt.eventLoop.run()
  expect(order).toEqual(["fn", "timer", "timer"])
}, 30_000)

it("start() and run() take over the implicit start; a second one gets ErrRunning", async () => {
  const { rt, engine } = await setup("export const x = 1")
  await rt.eventLoop.start()
  await expect(rt.eventLoop.start()).rejects.toMatchObject({
    message: "eventloop: loop is already running"
  })
  await expect(rt.eventLoop.run()).rejects.toMatchObject({ code: "ERR_LOOP_RUNNING" })
  const fresh = await engine.newRuntime()
  await fresh.eventLoop.run()
  await fresh.eventLoop.stop()
  const release = await fresh.eventLoop.hold()
  const first = fresh.eventLoop.run()
  await expect(fresh.eventLoop.run()).rejects.toMatchObject({ code: "ERR_LOOP_RUNNING" })
  await release()
  await first
}, 30_000)

it("an interrupted run() rejects once the native loop has stopped", async () => {
  const { rt } = await setup("export const x = 1")
  await rt.eventLoop.stop()
  const release = await rt.eventLoop.hold()
  const running = rt.eventLoop.run()
  await rt.stats()
  rt.interrupt("x")
  await expect(running).rejects.toMatchObject({ kind: "interrupted" })
  await rt.clearInterrupt()
  await release()
  await rt.eventLoop.run()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const waiting = rt.eventLoop.run(() => {
    entered.resolve()
    return gate.promise
  })
  await entered.promise
  rt.interrupt("y")
  await expect(waiting).rejects.toMatchObject({ kind: "interrupted" })
  gate.resolve()
  await rt.clearInterrupt()
}, 30_000)

it("run() waits for an outstanding async host call", async () => {
  const gate = Promise.withResolvers<number>()
  const { rt, hook } = await setup("export async function f() { return await slow() }")
  await rt.setGlobal("slow", async () => gate.promise)
  await rt.eventLoop.stop()
  const call = rt.call(hook("f"))
  let done = false
  const running = rt.eventLoop.run().then(() => (done = true))
  await rt.promiseState(0)
  expect(done).toBe(false)
  gate.resolve(3)
  await running
  expect(await call).toBe(3)
}, 30_000)

it("a bare runtime has no timers, Web APIs or loop, and newEventLoop installs timers", async () => {
  const { engine } = await setup("export const x = 1")
  const rt = await engine.newRuntime({ eventLoop: false })
  expect(await rt.evalScript("t.js", "typeof setTimeout + typeof fetch + typeof EventTarget")).toBe(
    "undefinedundefinedundefined"
  )
  await expect(rt.eventLoop.run()).rejects.toThrow("runtime has no event loop")
  rt.interrupt("x")
  await expect(rt.evalScript("a.js", "1")).rejects.toMatchObject({ kind: "interrupted" })
  await rt.clearInterrupt()
  expect(await rt.evalScript("b.js", "1")).toBe(1)
  const p = await rt.newPromise()
  await p.resolve(4)
  expect((await rt.promiseState(p.promise)).state).toBe("fulfilled")
  await rt.setGlobal("h", async () => 1)
  expect(await rt.evalScript("h.js", "h()")).toBe(1)
  const errors: string[] = []
  await rt.newEventLoop({ onError: (error) => void errors.push(error.message) })
  expect(await rt.evalScript("t2.js", "typeof setTimeout + typeof fetch")).toBe("functionundefined")
  await rt.evalScript("i.js", 'setImmediate(() => { throw new Error("new loop") }); undefined')
  await rt.eventLoop.run()
  expect(errors).toEqual(["new loop"])
  await expect(rt.newEventLoop()).rejects.toThrow("runtime already has an event loop")
}, 30_000)

it("newEventLoop after terminate and clearInterrupt restores timers", async () => {
  const { rt, hook } = await setup(`
    let count = 0
    export function schedule() { setTimeout(() => { count++ }, 1) }
    export function read() { return count }
  `)
  await rt.eventLoop.terminate()
  await rt.clearInterrupt()
  await rt.newEventLoop()
  await rt.call(hook("schedule"))
  await rt.eventLoop.run()
  expect(await rt.call(hook("read"))).toBe(1)
}, 30_000)
