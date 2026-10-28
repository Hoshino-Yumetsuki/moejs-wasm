import { afterEach, expect, it } from "vitest"
import {
  createMoeJS,
  MemoryLimitError,
  MoeJSError,
  nodeAdapter,
  type Adapter,
  type Engine,
  type WorkerHandlers
} from "moejs-wasm/node"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})
async function create(adapter?: Adapter) {
  const engine = await createMoeJS({ timeoutMs: 10_000, adapter })
  engines.push(engine)
  return engine
}
async function rejection(promise: Promise<unknown>): Promise<MoeJSError> {
  try {
    await promise
  } catch (error) {
    return error as MoeJSError
  }
  throw new Error("expected a rejection")
}
function layers(error: MoeJSError | undefined): MoeJSError[] {
  const out: MoeJSError[] = []
  for (; error; error = error.cause instanceof MoeJSError ? error.cause : undefined) out.push(error)
  return out
}

it("renders interrupt reasons like upstream and keeps their identity", async () => {
  const engine = await create()
  const mod = await engine.compile(
    "interrupts.js",
    "export function wait() { return new Promise(() => {}) }\nexport function ok() { return 1 }"
  )
  const object = { why: "object" }
  const error = new Error("stop now")
  const cases: [unknown, string][] = [
    [undefined, "interrupted"],
    ["pause", "interrupted: pause"],
    [object, "interrupted: [object Object]"],
    [error, "interrupted: stop now"]
  ]
  for (const [reason, message] of cases) {
    const rt = await engine.newRuntime()
    await rt.load(mod)
    const running = rejection(rt.call(mod.hook("wait")))
    await rt.promiseState(0)
    rt.interrupt(reason)
    const later = await rejection(rt.call(mod.hook("ok")))
    for (const stopped of [await running, later]) {
      expect(stopped).toMatchObject({
        kind: "interrupted",
        name: "InterruptedError",
        code: "ERR_INTERRUPTED",
        message
      })
      expect(layers(stopped).some((layer) => layer.message === "host interrupt")).toBe(false)
      if (reason === object) expect(stopped.reason).toBe(object)
      if (reason === error) {
        expect((stopped.cause as Error).message).toBe("stop now")
        expect(stopped.is(error)).toBe(true)
      }
    }
    await rt.close()
  }
}, 30_000)

it("routes eventLoop.interrupt through the same payload", async () => {
  const engine = await create()
  const mod = await engine.compile("loop-interrupt.js", "export function ok() { return 1 }")
  const rt = await engine.newRuntime()
  await rt.load(mod)
  const reason = { from: "loop" }
  await rt.eventLoop.interrupt(reason)
  const stopped = await rejection(rt.call(mod.hook("ok")))
  expect(stopped).toMatchObject({ kind: "interrupted", message: "interrupted: [object Object]" })
  expect(stopped.reason).toBe(reason)
}, 30_000)

it("keeps a suspended sync host call uncatchable on interrupt", async () => {
  const engine = await create()
  const mod = await engine.compile(
    "blocked.js",
    `
    let caught = false
    export function run() { try { blocked() } catch { caught = true } }
    export function state() { return caught }
  `
  )
  const rt = await engine.newRuntime()
  const started = Promise.withResolvers<void>()
  await rt.setGlobal(
    "blocked",
    rt.function("blocked", 0, () => {
      started.resolve()
      return new Promise(() => {})
    })
  )
  await rt.load(mod)
  const running = rejection(rt.call(mod.hook("run")))
  await started.promise
  rt.interrupt("x")
  expect(await running).toMatchObject({ kind: "interrupted" })
  await rt.clearInterrupt()
  expect(await rt.call(mod.hook("state"))).toBe(false)
}, 30_000)

it("reports memory-limit hits as interrupts with complete fields", async () => {
  const engine = await create()
  const mod = await engine.compile(
    "hit.js",
    'export function allocate() { try { return new Array(1e6).fill("x") } catch { return "escaped" } }'
  )
  const rt = await engine.newRuntime({ memoryLimit: 1_000_000 })
  await rt.load(mod)
  const hit = await rejection(rt.call(mod.hook("allocate")))
  expect(hit).toMatchObject({
    kind: "interrupted",
    message: expect.stringMatching(/^interrupted: memory limit exceeded: /),
    cause: { kind: "memory", name: "MemoryLimitError", code: "ERR_MEMORY_LIMIT", limit: 1_000_000 }
  })
  const cause = hit.cause as MemoryLimitError
  expect(cause).toBeInstanceOf(MemoryLimitError)
  expect([typeof cause.allocated, typeof cause.live, typeof cause.stack]).toEqual([
    "number",
    "number",
    "string"
  ])
  expect(cause.cause).toMatchObject({ code: "ERR_MEMORY_LIMIT", message: "memory limit exceeded" })
  expect(hit.is("ERR_MEMORY_LIMIT")).toBe(true)
}, 30_000)

it("returns RebaseAllocation's MemoryLimitError uninterrupted, and host rethrows keep the difference", async () => {
  const engine = await create()
  const mod = await engine.compile(
    "rebase.js",
    `
    export function keep() { return new Uint8Array(1_200_000) }
    export function allocate() { return new Array(1e6).fill("x") }
    export function relay() { try { host(); return "uncaught" } catch (e) { return e.message } }
  `
  )
  const rt = await engine.newRuntime({ memoryLimit: 2_000_000 })
  await rt.load(mod)
  await rt.eventLoop.stop()
  const kept = [await rt.callValue(mod.hook("keep"))]
  await rt.releaseCallData()
  kept.push(await rt.callValue(mod.hook("keep")))
  await rt.releaseCallData()
  const rebase = await rejection(rt.rebaseAllocation(kept))
  expect(rebase).toBeInstanceOf(MemoryLimitError)
  expect(rebase).toMatchObject({ kind: "memory", code: "ERR_MEMORY_LIMIT", allocated: 0 })
  expect(rebase.limit).toBe(2_000_000)
  expect(rebase.live).toBeGreaterThanOrEqual(2_400_000)
  expect(rebase.stack).toBe("")
  const limited = await engine.newRuntime({ memoryLimit: 1_000_000 })
  await limited.load(mod)
  const hit = await rejection(limited.call(mod.hook("allocate")))
  const relay = await engine.newRuntime()
  let thrown: unknown = rebase
  await relay.setGlobal(
    "host",
    relay.function("host", 0, () => {
      throw thrown
    })
  )
  await relay.load(mod)
  expect(await relay.call(mod.hook("relay"))).toMatch(/^memory limit exceeded: /)
  thrown = hit
  expect(await rejection(relay.call(mod.hook("relay")))).toMatchObject({
    kind: "interrupted",
    cause: { kind: "memory" }
  })
}, 30_000)

it("reports a Go panic as InternalError, keeps the runtime usable, and rethrows it with one prefix", async () => {
  const engine = await create()
  const mod = await engine.compile(
    "panic.js",
    `
    export function now() { return Date.now() }
    export function ok() { return 42 }
    export function hopped() { try { hop() } catch (e) { return e.message } }
    export function uncaught() { hop() }
  `
  )
  const rt = await engine.newRuntime()
  await rt.load(mod)
  await (
    await rt.realm()
  ).invoke("SetNow", () => {
    throw new Error("boom")
  })
  expect(await rejection(rt.call(mod.hook("now")))).toMatchObject({
    kind: "internal",
    name: "InternalError",
    code: "ERR_INTERNAL",
    message: expect.stringMatching(/^moejs: internal error: /)
  })
  expect(await rt.call(mod.hook("ok"))).toBe(42)
  const now = await rt.getValue("now")
  await rt.setGlobal(
    "hop",
    rt.function("hop", 0, async () => {
      await rt.callFunction(now, undefined)
    })
  )
  const message = await rt.call<string>(mod.hook("hopped"))
  expect(message).toMatch(/^moejs: internal error: /)
  expect(message.split("internal error: ")).toHaveLength(2)
  expect(await rejection(rt.call(mod.hook("uncaught")))).toMatchObject({
    kind: "exception",
    code: "ERR_INTERNAL",
    cause: { kind: "internal" }
  })
}, 30_000)

it("maps hook lookup failures and engine sentinels to upstream codes", async () => {
  const engine = await create()
  const mod = await engine.compile(
    "hooks.js",
    "export const nil = null\nexport const num = 1\nexport const obj = { f() {} }"
  )
  const rt = await engine.newRuntime()
  await rt.load(mod)
  const notFound = {
    kind: "bridge",
    name: "Error",
    code: "ERR_HOOK_NOT_FOUND",
    message: "moejs: hook not found"
  }
  expect(await rejection(rt.call(mod.hook("nil")))).toMatchObject(notFound)
  expect(await rejection(rt.call(mod.hook("num")))).toMatchObject({
    code: "ERR_NOT_CALLABLE",
    message: "moejs: not a function"
  })
  expect(await rejection(rt.call(mod.hook("obj", "missing")))).toMatchObject(notFound)
  expect(() => mod.hook("nope")).toThrow(expect.objectContaining({ code: "ERR_HOOK_NOT_FOUND" }))
  expect(await rejection(rt.callFunction(await rt.fromHost({}), undefined))).toMatchObject({
    code: "ERR_NOT_CALLABLE",
    name: "Error",
    message: "moejs: not a function"
  })
  const entry = await engine.compile("entry.js", 'import "dep"')
  const unresolved = await rejection(engine.link(entry, undefined as never))
  expect(unresolved).toMatchObject({
    name: "ResolveError",
    code: "ERR_MODULE_RESOLVE",
    specifier: "dep",
    message: expect.stringMatching(
      /: cannot resolve module "dep": no resolver: the host must resolve the module's requests$/
    ),
    cause: {
      code: "ERR_NO_RESOLVER",
      message: "no resolver: the host must resolve the module's requests"
    }
  })
  expect(unresolved.is("ERR_NO_RESOLVER")).toBe(true)
}, 30_000)

it("rejects another runtime's handles with ERR_FOREIGN", async () => {
  const engine = await create()
  const mod = await engine.compile("foreign.js", "export function f(x) { return x }")
  const first = await engine.newRuntime()
  const second = await engine.newRuntime()
  await second.load(mod)
  const foreign = {
    code: "ERR_FOREIGN",
    message: "moejs: function or generator of another runtime"
  }
  const value = await first.fromHost(() => 1)
  expect(await rejection(second.call(mod.hook("f"), value))).toMatchObject(foreign)
  expect(await rejection(second.setGlobal("x", await first.realm()))).toMatchObject(foreign)
  expect(await rejection(second.fromHost({ nested: value }))).toMatchObject(foreign)
}, 30_000)

it("maps ErrTerminated and ErrRunning, and keeps post-Terminate settles and holds no-ops", async () => {
  const engine = await create()
  const mod = await engine.compile("loop.js", "export function ok() { return 1 }")
  const running = await engine.newRuntime()
  await running.eventLoop.start().catch(() => {})
  expect(await rejection(running.eventLoop.start())).toMatchObject({
    code: "ERR_LOOP_RUNNING",
    message: "eventloop: loop is already running"
  })
  await running.load(mod)
  await running.setGlobal(
    "host",
    running.function("host", 0, async () => {
      await running.eventLoop.run()
    })
  )
  const inside = await running.evalScriptValue("inside.js", "() => host()")
  expect(await rejection(running.callFunction(inside, undefined))).toMatchObject({
    code: "ERR_LOOP_RUNNING"
  })
  const rt = await engine.newRuntime()
  await rt.load(mod)
  const promise = await rt.newPromise()
  await rt.eventLoop.terminate()
  await promise.resolve(1)
  expect(await rejection(rt.eventLoop.run())).toMatchObject({
    code: "ERR_LOOP_TERMINATED",
    message: "eventloop: loop terminated"
  })
  const stopped = await rejection(rt.call(mod.hook("ok")))
  expect(stopped).toMatchObject({
    kind: "interrupted",
    message: "interrupted: eventloop: loop terminated",
    cause: { code: "ERR_LOOP_TERMINATED" }
  })
  expect(stopped.is("ERR_LOOP_TERMINATED")).toBe(true)
  const release = await rt.eventLoop.hold()
  await release()
}, 30_000)

it("throws guest Values from host functions as is, and other values as Errors", async () => {
  const engine = await create()
  const mod = await engine.compile(
    "throws.js",
    `
    export function same() { try { host() } catch (e) { return e === globalThis.marker } }
    export function caught() { try { host() } catch (e) { return [e instanceof Error, e.message] } }
    export function named() { try { host() } catch (e) { return [e.name, Object.hasOwn(e, "name"), e.message] } }
    export function uncaught() { host() }
  `
  )
  const rt = await engine.newRuntime()
  await rt.load(mod)
  const marker = await rt.evalScriptValue("marker.js", "globalThis.marker = {}; globalThis.marker")
  let thrown: unknown = marker
  await rt.setGlobal(
    "host",
    rt.function("host", 0, () => {
      throw thrown
    })
  )
  expect(await rt.call(mod.hook("same"))).toBe(true)
  thrown = 42
  expect(await rt.call(mod.hook("caught"))).toEqual([true, "42"])
  class MyErr extends Error {
    override name = "MyErr"
  }
  thrown = new MyErr("nope")
  expect(await rt.call(mod.hook("named"))).toEqual(["Error", false, "nope"])
  const uncaught = await rejection(rt.call(mod.hook("uncaught")))
  expect(uncaught).toMatchObject({ kind: "exception", message: "nope", cause: { name: "MyErr" } })
  expect(uncaught.is(thrown as object)).toBe(true)
  const value = await rt.thrownValue(42)
  expect(value.ok).toBe(true)
  expect(await (await value.value.get("message")).toGo()).toBe("42")
}, 30_000)

it("reports a dead endpoint as kind fatal", async () => {
  const native = nodeAdapter()
  const handlers: WorkerHandlers[] = []
  const engine = await create({
    loadModule: (url) => native.loadModule(url),
    async createWorker(module, options, events) {
      handlers.push(events)
      return native.createWorker(module, options, events)
    }
  })
  const mod = await engine.compile(
    "dead.js",
    "export function wait() { return new Promise(() => {}) }"
  )
  const rt = await engine.newRuntime()
  await rt.load(mod)
  const pending = rejection(rt.call(mod.hook("wait")))
  await rt.promiseState(0)
  handlers.at(-1)!.error(new Error("worker died"))
  expect(await pending).toMatchObject({ kind: "fatal", message: "worker died" })
}, 30_000)
