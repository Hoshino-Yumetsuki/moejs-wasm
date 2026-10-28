import { readFile } from "node:fs/promises"
import { createMoeJS } from "moejs-wasm"
import { createMoeJS as createPortable } from "moejs-wasm/wasm"
import { expect, it } from "vitest"
import { hostDecodes, hostPlatform, NetworkHost, networkError, type Platform } from "../src/network"

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
      value: new Uint8Array([1])
    })
    expect(pulls).toBe(1)
    await host.handle({ type: "networkRequest", id: 3, kind: "cancel", bodyId: 1 })
    expect(canceled).toBe(true)
    expect(signal?.aborted).toBe(true)
  } finally {
    host.close()
  }
})

it("sends only a chunk's bytes and rejects chunks that are not bytes", async () => {
  const pooled = new Uint8Array(65536)
  pooled.set([7, 8, 9], 100)
  const chunks: unknown[] = [pooled.subarray(100, 103), new ArrayBuffer(2)]
  const host = new NetworkHost({
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunks.shift())
          }
        })
      )
  })
  try {
    await host.handle({
      type: "networkRequest",
      id: 1,
      kind: "fetch",
      request: { url: "https://example.test/chunks", method: "GET", headers: [] }
    })
    const first = (await host.handle({
      type: "networkRequest",
      id: 2,
      kind: "read",
      bodyId: 1
    })) as {
      value: Uint8Array
    }
    expect(first.value).toEqual(new Uint8Array([7, 8, 9]))
    expect(first.value.buffer.byteLength).toBe(3)
    await expect(
      host.handle({ type: "networkRequest", id: 3, kind: "read", bodyId: 1 })
    ).rejects.toThrow("Network response body chunks must be Uint8Array")
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
      // Like a non-nil Client with a nil Allow, a custom fetch alone enables the network.
      const enabled = await engine.newRuntime({
        network: { fetch: async () => new Response("custom transport") }
      })
      await enabled.load(mod)
      expect(await enabled.call(mod.hook("text"), "https://anywhere.test/ok")).toBe(
        "custom transport"
      )
      const denied = await engine.newRuntime({
        network: {
          allowHosts: [],
          fetch: async () => {
            throw new Error("allowHosts: [] must still deny every host")
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

it("gives the guest the host's allow denial reason as the TypeError cause", async () => {
  const wasm = Uint8Array.from(await readFile(new URL("../lib/moejs.wasm", import.meta.url)))
  for (const create of [() => createMoeJS(), () => createPortable({ wasm })]) {
    const engine = await create()
    try {
      const mod = await engine.compile(
        "allow-reason.js",
        `
        export async function reason(url) {
          try { await fetch(url) } catch (e) { return [e.name, e.message, e.cause?.message] }
        }
      `
      )
      const runtime = await engine.newRuntime({
        network: {
          allow: (request) => {
            const { hostname } = new URL(request.url)
            if (hostname === "thrown.test") throw new Error("tenant policy")
            return hostname !== "denied.test"
          },
          fetch: async (input) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (url.endsWith("/redirect"))
              return new Response(null, {
                status: 302,
                headers: { location: "https://thrown.test/" }
              })
            return new Response("ok")
          }
        }
      })
      await runtime.load(mod)
      const reason = mod.hook("reason")
      expect(await runtime.call(reason, "https://thrown.test/")).toEqual([
        "TypeError",
        "fetch failed",
        "tenant policy"
      ])
      expect(await runtime.call(reason, "https://denied.test/")).toEqual([
        "TypeError",
        "fetch failed",
        "Network request denied by host policy"
      ])
      expect(await runtime.call(reason, "https://allowed.test/redirect")).toEqual([
        "TypeError",
        "fetch failed",
        'Get "https://thrown.test/": tenant policy'
      ])
    } finally {
      await engine.close()
    }
  }
}, 30_000)

it("reports which content codings the host fetch decoded", () => {
  expect(hostDecodes("deflate", false)).toBe(true)
  expect(hostDecodes("gzip, br", false)).toBe(true)
  expect(hostDecodes("compress", false)).toBe(false)
  expect(hostDecodes("deflate", true)).toBe(false)
  expect(hostDecodes("gzip", true)).toBe(true)
  expect(hostDecodes("gzip, br", true)).toBe(false)
})

it("decodes host content codings once, as Go's transport and webapi do", async () => {
  const wasm = Uint8Array.from(await readFile(new URL("../lib/moejs.wasm", import.meta.url)))
  for (const create of [() => createMoeJS(), () => createPortable({ wasm })]) {
    const engine = await create()
    const sent: (string | null)[] = []
    try {
      const mod = await engine.compile(
        "codings.js",
        `
        export async function get(url, headers) {
          const r = await fetch(url, { headers })
          return [await r.text(), r.headers.get("content-encoding"), [...r.headers.keys()].filter((k) => k.startsWith("x-moejs"))]
        }
        export async function head(url) { return (await fetch(url, { method: "HEAD" })).headers.get("content-encoding") }
      `
      )
      const runtime = await engine.newRuntime({
        network: {
          allowHosts: ["codings.test"],
          fetch: async (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            sent.push(new Headers(init?.headers).get("accept-encoding"))
            return new Response(init?.method === "HEAD" ? null : "hello", {
              headers: { "content-encoding": new URL(url).pathname.slice(1) }
            })
          }
        }
      })
      await runtime.load(mod)
      const get = mod.hook("get")
      expect(await runtime.call(get, "https://codings.test/gzip")).toEqual(["hello", null, []])
      expect(
        await runtime.call(get, "https://codings.test/gzip", { "accept-encoding": "gzip" })
      ).toEqual(["hello", "gzip", []])
      expect(await runtime.call(get, "https://codings.test/deflate")).toEqual([
        "hello",
        "deflate",
        []
      ])
      expect(await runtime.call(get, "https://codings.test/x-gzip")).toEqual([
        "hello",
        "x-gzip",
        []
      ])
      expect(await runtime.call(mod.hook("head"), "https://codings.test/gzip")).toBe("gzip")
      expect(sent).toEqual(["gzip", "gzip", "gzip", "gzip", null])
    } finally {
      await engine.close()
    }
  }
}, 30_000)

const nodeProfile: Platform = { workerd: false, browser: false, streams: true, init: {} }
const request = { url: "https://up.test/", method: "POST", headers: [] as [string, string][] }

it("feeds a streamed request body only on demand", async () => {
  let body: ReadableStream<Uint8Array> | undefined
  let duplex: unknown
  const host = new NetworkHost(
    {
      fetch: async (_input, init) => {
        body = init?.body as ReadableStream<Uint8Array>
        duplex = (init as { duplex?: unknown }).duplex
        return new Response("ok")
      }
    },
    nodeProfile
  )
  const fetching = host.handle({
    type: "networkRequest",
    id: 1,
    kind: "fetch",
    request,
    init: { method: "POST", headers: [], stream: true }
  })
  let taken = false
  const write = host
    .handle({ type: "networkRequest", id: 2, kind: "write", bodyId: 1, chunk: new Uint8Array([7]) })
    .then((value) => ((taken = true), value))
  await fetching
  expect(duplex).toBe("half")
  await Promise.resolve()
  expect(taken).toBe(false)
  const reader = body!.getReader()
  expect((await reader.read()).value).toEqual(new Uint8Array([7]))
  expect(await write).toBeNull()
  await host.handle({ type: "networkRequest", id: 3, kind: "write", bodyId: 1 })
  expect((await reader.read()).done).toBe(true)
})

it("buffers a streamed body where the platform cannot stream", async () => {
  const bodies: unknown[] = []
  const host = new NetworkHost(
    {
      fetch: async (_input, init) => {
        bodies.push(init?.body)
        return new Response("ok")
      }
    },
    { ...nodeProfile, streams: false }
  )
  const fetching = host.handle({
    type: "networkRequest",
    id: 1,
    kind: "fetch",
    request,
    init: { method: "POST", headers: [], stream: true }
  })
  await host.handle({
    type: "networkRequest",
    id: 2,
    kind: "write",
    bodyId: 1,
    chunk: new Uint8Array([1])
  })
  await host.handle({
    type: "networkRequest",
    id: 3,
    kind: "write",
    bodyId: 1,
    chunk: new Uint8Array([2])
  })
  expect(bodies).toEqual([])
  await host.handle({ type: "networkRequest", id: 4, kind: "write", bodyId: 1 })
  await fetching
  expect(bodies).toEqual([new Uint8Array([1, 2])])
})

it("adds transport defaults outside browsers and passes the platform init", async () => {
  const inits: RequestInit[] = []
  const fetch = async (_input: unknown, init?: RequestInit) => {
    inits.push(init!)
    return new Response(null)
  }
  const message = {
    type: "networkRequest" as const,
    id: 1,
    kind: "fetch" as const,
    request: { ...request, method: "GET" },
    init: {
      method: "GET",
      headers: [["x", "1"]] as [string, string][],
      defaults: [["User-Agent", "Go-http-client/1.1"]] as [string, string][]
    }
  }
  await new NetworkHost({ fetch }, hostPlatform()).handle(message)
  await new NetworkHost({ fetch }, { ...nodeProfile, browser: true }).handle({ ...message, id: 2 })
  expect(inits[0]).toMatchObject({
    headers: [
      ["x", "1"],
      ["User-Agent", "Go-http-client/1.1"]
    ],
    cache: "no-store",
    referrer: "",
    redirect: "manual",
    credentials: "omit"
  })
  expect(inits[1]!.headers).toEqual([["x", "1"]])
})

it("serializes host errors with their code", () => {
  expect(
    networkError(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
          code: "ECONNREFUSED"
        })
      })
    )
  ).toEqual({
    message: "fetch failed: connect ECONNREFUSED 127.0.0.1:1",
    name: "TypeError",
    code: "ECONNREFUSED"
  })
  expect(networkError(new DOMException("x", "TimeoutError"))).toMatchObject({ code: "ETIMEDOUT" })
  expect(networkError("plain")).toEqual({ message: "plain" })
})
