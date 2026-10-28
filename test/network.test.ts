import { createServer } from "node:http"
import { once } from "node:events"
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib"
import { expect, it } from "vitest"
import { createMoeJS } from "moejs-wasm"

it("uses native fetch policy, streams, cancellation and runtime cleanup over real HTTP", async () => {
  let requests = 0
  const { promise: streamDone, resolve: streamClosed } = Promise.withResolvers<void>()
  const { promise: pendingReady, resolve: pendingStarted } = Promise.withResolvers<void>()
  const { promise: pendingDone, resolve: pendingClosed } = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    requests++
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `http://localhost:${port}/ok` })
      response.end()
    } else if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/plain" })
      response.write("first chunk")
      response.once("close", streamClosed)
    } else if (request.url === "/pending") {
      response.once("close", pendingClosed)
      pendingStarted()
    } else {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ method: request.method, value: 42 }))
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener")
  const port = address.port
  const base = `http://127.0.0.1:${port}`
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const mod = await engine.compile(
      "network.js",
      `
      export async function get(url) { return (await fetch(url)).json() }
      export async function stream(url) {
        const response = await fetch(new Request(url))
        const reader = response.body.getReader()
        const chunk = await reader.read()
        await reader.cancel()
        return [response.status, new TextDecoder().decode(chunk.value), chunk.done]
      }
      export async function abort(url) {
        const controller = new AbortController()
        const pending = fetch(url, { signal: controller.signal })
        controller.abort()
        try { await pending } catch (error) { return error.name }
      }
    `
    )
    const denied = await engine.newRuntime()
    await denied.load(mod)
    await expect(denied.call(mod.hook("get"), `${base}/ok`)).rejects.toMatchObject({
      name: "TypeError"
    })
    expect(requests).toBe(0)
    const empty = await engine.newRuntime({ network: { allowHosts: [] } })
    await empty.load(mod)
    await expect(empty.call(mod.hook("get"), `${base}/ok`)).rejects.toMatchObject({
      name: "TypeError"
    })
    expect(requests).toBe(0)

    const runtime = await engine.newRuntime({ network: { allowHosts: ["127.0.0.1"] } })
    await runtime.load(mod)
    expect(await runtime.call(mod.hook("get"), `${base}/ok`)).toEqual({ method: "GET", value: 42 })
    const beforeRedirect = requests
    await expect(runtime.call(mod.hook("get"), `${base}/redirect`)).rejects.toMatchObject({
      name: "TypeError"
    })
    expect(requests).toBe(beforeRedirect + 1)
    expect(await runtime.call(mod.hook("stream"), `${base}/stream`)).toEqual([
      200,
      "first chunk",
      false
    ])
    await streamDone
    expect(await runtime.call(mod.hook("abort"), `${base}/ok`)).toBe("AbortError")

    const pending = runtime.call(mod.hook("get"), `${base}/pending`).then(
      () => {
        throw new Error("Closed fetch unexpectedly resolved")
      },
      (error: unknown) => error
    )
    await pendingReady
    await runtime.close()
    await expect(pending).resolves.toMatchObject({ kind: "closed" })
    await pendingDone
  } finally {
    await engine.close()
    server.closeAllConnections()
    const stopped = once(server, "close")
    server.close()
    await stopped
  }
}, 30_000)

it("decodes deflate, raw deflate, x-gzip and gzip bodies once over real HTTP", async () => {
  const seen: (string | undefined)[] = []
  const bodies: Record<string, [string, Buffer]> = {
    "/zlib": ["deflate", deflateSync("hello")],
    "/deflate": ["deflate", deflateRawSync("hello")],
    "/x-gzip": ["x-gzip", gzipSync("hello")],
    "/gzip": ["gzip", gzipSync("hello")]
  }
  const server = createServer((request, response) => {
    seen.push(request.headers["accept-encoding"])
    const [coding, body] = bodies[request.url!]!
    response.writeHead(200, { "content-encoding": coding })
    response.end(body)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener")
  const base = `http://127.0.0.1:${address.port}`
  const engine = await createMoeJS({ timeoutMs: 10_000 })
  try {
    const mod = await engine.compile(
      "codings.js",
      `
      export async function get(url, ae) {
        const r = await fetch(url, ae ? { headers: { "Accept-Encoding": ae } } : {})
        return [await r.text(), r.headers.get("content-encoding")]
      }
    `
    )
    const runtime = await engine.newRuntime({ network: { allowHosts: ["127.0.0.1"] } })
    await runtime.load(mod)
    const get = mod.hook("get")
    expect(await runtime.call(get, `${base}/zlib`, "deflate")).toEqual(["hello", "deflate"])
    expect(await runtime.call(get, `${base}/deflate`, "deflate")).toEqual(["hello", "deflate"])
    expect(await runtime.call(get, `${base}/x-gzip`)).toEqual(["hello", "x-gzip"])
    expect(await runtime.call(get, `${base}/gzip`)).toEqual(["hello", null])
    expect(await runtime.call(get, `${base}/gzip`, "gzip")).toEqual(["hello", "gzip"])
    expect(seen).toEqual(["deflate", "deflate", "gzip", "gzip", "gzip"])
  } finally {
    await engine.close()
    server.close()
  }
}, 30_000)
