import { readFile } from "node:fs/promises"
import { createMoeJS } from "moejs-wasm"
import { createMoeJS as createPortable } from "moejs-wasm/wasm"
import { expect, it } from "vitest"
import { NetworkHost } from "../src/network"

it("pulls host response chunks on demand and cancels resources", async () => {
  let pulls = 0
  let canceled = false
  let signal: AbortSignal | null | undefined
  const host = new NetworkHost({
    fetch: async (_input, init) => {
      signal = init?.signal
      expect(init?.redirect).toBe("manual")
      expect(init?.credentials).toBe("omit")
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++
              controller.enqueue(new Uint8Array([pulls]))
            },
            cancel() {
              canceled = true
            }
          },
          { highWaterMark: 0 }
        )
      )
    }
  })
  try {
    const response = await host.handle({
      type: "networkRequest",
      id: 1,
      kind: "fetch",
      request: { url: "https://example.test/", method: "GET", headers: [] }
    })
    expect(response).toMatchObject({ status: 200, bodyId: 1 })
    expect(pulls).toBe(0)
    expect(await host.handle({ type: "networkRequest", id: 2, kind: "read", bodyId: 1 })).toEqual({
      done: false,
      value: [1]
    })
    expect(pulls).toBe(1)
    await host.handle({ type: "networkRequest", id: 3, kind: "cancel", bodyId: 1 })
    expect(canceled).toBe(true)
    expect(signal?.aborted).toBe(true)
  } finally {
    host.close()
  }
})

it("rejects a blocked host read when cancellation closes its stream", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>()
  const { promise: canceled, resolve: cancel } = Promise.withResolvers<void>()
  const host = new NetworkHost({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              start()
            },
            cancel() {
              cancel()
            }
          },
          { highWaterMark: 0 }
        )
      )
  })
  try {
    await host.handle({
      type: "networkRequest",
      id: 1,
      kind: "fetch",
      request: { url: "https://example.test/blocked", method: "GET", headers: [] }
    })
    const pending = host.handle({ type: "networkRequest", id: 2, kind: "read", bodyId: 1 })
    const rejected = expect(pending).rejects.toThrow("Network request canceled")
    await started
    await host.handle({ type: "networkRequest", id: 3, kind: "cancel", bodyId: 1 })
    await rejected
    await canceled
  } finally {
    host.close()
  }
})

it("bridges custom fetch and asynchronous per-hop policy in workers and portable WASM", async () => {
  const wasm = Uint8Array.from(await readFile(new URL("../lib/moejs.wasm", import.meta.url)))
  for (const create of [() => createMoeJS(), () => createPortable({ wasm })]) {
    const engine = await create()
    const sent: string[] = []
    const allowed: string[] = []
    try {
      const mod = await engine.compile(
        "network-host.js",
        `
        export async function text(url) { return (await fetch(url)).text() }
        export async function post(url) {
          return (await fetch(url, {method: 'POST', body: 'request body'})).text()
        }
      `
      )
      const runtime = await engine.newRuntime({
        network: {
          allow: async (request) => {
            await Promise.resolve()
            allowed.push(request.url)
            return new URL(request.url).hostname === "allowed.test"
          },
          fetch: async (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            sent.push(url)
            expect(init?.redirect).toBe("manual")
            expect(init?.credentials).toBe("omit")
            if (url.endsWith("/redirect")) {
              return new Response(null, {
                status: 302,
                headers: { location: "https://denied.test/" }
              })
            }
            if (init?.method === "POST") {
              return new Response(await new Response(init.body).text())
            }
            return new Response("host response")
          }
        }
      })
      await runtime.load(mod)
      expect(await runtime.call(mod.hook("text"), "https://allowed.test/ok")).toBe("host response")
      expect(await runtime.call(mod.hook("post"), "https://allowed.test/post")).toBe("request body")
      await expect(
        runtime.call(mod.hook("text"), "https://allowed.test/redirect")
      ).rejects.toMatchObject({ name: "TypeError" })
      expect(allowed).toContain("https://denied.test/")
      expect(sent).not.toContain("https://denied.test/")
      const denied = await engine.newRuntime({
        network: {
          fetch: async () => {
            throw new Error("Default-denied fetch must not reach the host")
          }
        }
      })
      await denied.load(mod)
      await expect(denied.call(mod.hook("text"), "https://allowed.test/ok")).rejects.toMatchObject({
        name: "TypeError"
      })
    } finally {
      await engine.close()
    }
  }
}, 30_000)

it("cancels only a run's blocked body, resets its context and keeps the runtime reusable", async () => {
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  const { promise: started, resolve: start } = Promise.withResolvers<void>()
  const { promise: closed, resolve: close } = Promise.withResolvers<void>()
  try {
    const mod = await engine.compile(
      "network-context.js",
      `
      export async function text(url) { return (await fetch(url)).text() }
      export function value() { return 42 }
    `
    )
    const runtime = await engine.newRuntime({
      network: {
        allowHosts: ["context.test"],
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.endsWith("/blocked")) {
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull() {
                    start()
                  },
                  cancel() {
                    close()
                  }
                },
                { highWaterMark: 0 }
              )
            )
          }
          return new Response("next run")
        }
      }
    })
    await runtime.load(mod)
    const controller = new AbortController()
    await runtime.network.setContext(controller.signal)
    const pending = runtime.call(mod.hook("text"), "https://context.test/blocked")
    const rejected = expect(pending).rejects.toMatchObject({ name: "TypeError" })
    await started
    controller.abort()
    await rejected
    await closed
    await runtime.network.setContext()
    expect(await runtime.call(mod.hook("text"), "https://context.test/ok")).toBe("next run")
    await runtime.network.close()
    await expect(runtime.call(mod.hook("text"), "https://context.test/ok")).rejects.toMatchObject({
      name: "TypeError"
    })
    expect(await runtime.call(mod.hook("value"))).toBe(42)
  } finally {
    await engine.close()
  }
}, 30_000)

it("applies an already-canceled network parent without closing the guest runtime", async () => {
  const engine = await createMoeJS()
  const controller = new AbortController()
  controller.abort()
  let fetched = false
  try {
    const mod = await engine.compile(
      "network-parent.js",
      `
      export async function get() { return (await fetch('https://parent.test/')).text() }
      export function value() { return 42 }
    `
    )
    const runtime = await engine.newRuntime({
      network: {
        signal: controller.signal,
        allowHosts: ["parent.test"],
        fetch: async () => {
          fetched = true
          return new Response("unexpected")
        }
      }
    })
    await runtime.load(mod)
    await expect(runtime.call(mod.hook("get"))).rejects.toMatchObject({ name: "TypeError" })
    expect(fetched).toBe(false)
    expect(await runtime.call(mod.hook("value"))).toBe(42)
  } finally {
    await engine.close()
  }
}, 15_000)
