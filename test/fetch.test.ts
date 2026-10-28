import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { gzipSync } from "node:zlib"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  createMoeJS,
  ErrUseLastResponse,
  type Engine,
  type NetworkOptions,
  type RuntimeNetwork
} from "moejs-wasm"
import { createMoeJS as createPortable } from "moejs-wasm/wasm"

let base = ""
let streamSeen = Promise.withResolvers<void>()
const cookies: string[] = []
const routes: Record<
  string,
  (request: IncomingMessage, response: ServerResponse, body: string) => void
> = {
  "/echo": (request, response, body) => {
    response.writeHead(200, { "content-type": "application/json", "x-multi": ["a", "b"] })
    response.end(
      JSON.stringify({
        method: request.method,
        body,
        accept: request.headers.accept,
        host: request.headers.host,
        ua: request.headers["user-agent"],
        ae: request.headers["accept-encoding"],
        cookie: request.headers.cookie ?? "",
        query: request.url!.split("?")[1] ?? ""
      })
    )
  },
  "/redirect": (_request, response) => {
    response.writeHead(302, { location: "/echo?from=redirect" })
    response.end()
  },
  "/gzip": (_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip" })
    response.end(gzipSync("hello"))
  },
  "/reason": (_request, response) => {
    response.writeHead(299, "Custom Reason")
    response.end()
  },
  "/chunks": (_request, response) => {
    response.write("a")
    setTimeout(() => response.end("b"), 5)
  },
  "/reset": (request) => {
    request.socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial")
    setTimeout(() => request.socket.destroy(), 20)
  },
  "/slow": () => {},
  "/set-cookie": (_request, response) => {
    response.writeHead(200, { "set-cookie": "s=1" })
    response.end("ok")
  }
}
const server = createServer((request, response) => {
  const path = request.url!.split("?")[0]!
  if (path === "/stream-echo") {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString()
      streamSeen.resolve()
    })
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify([
          body,
          request.headers["content-length"] ?? null,
          request.headers["transfer-encoding"]
        ])
      )
    })
    return
  }
  if (path === "/seen") {
    void streamSeen.promise.then(() => response.end("seen"))
    return
  }
  let body = ""
  request.on("data", (chunk: Buffer) => (body += chunk.toString()))
  request.on("end", () => {
    if (path === "/set-cookie" || path === "/echo") cookies.push(request.headers.cookie ?? "")
    ;(routes[path] ?? ((_q, r) => r.writeHead(404).end()))(request, response, body)
  })
})
beforeAll(async () => {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener")
  base = `http://127.0.0.1:${address.port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

const guest = `
  export async function json(url, init) { return (await fetch(url, init)).json() }
  export async function text(url, init) { return (await fetch(url, init)).text() }
  export async function info(url, init) {
    const r = await fetch(url, init)
    return [r.status, r.statusText, r.redirected, r.url, r.headers.get("x-multi"), r.headers.get("transfer-encoding"), r.headers.get("location"), await r.text()]
  }
  export async function fail(url, init) {
    try { const r = await fetch(url, init); await r.text(); return "ok" }
    catch (e) { return [e.name, e.message, e.cause?.message, e.cause?.code ?? null] }
  }
  export async function partial(url) {
    const r = await fetch(url)
    const reader = r.body.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    try { await reader.read(); await reader.read(); return "ok" }
    catch (e) { return [first, e.name, e.message, e.cause?.code ?? null] }
  }
  export async function stream(url) {
    let i = 0
    const body = new ReadableStream({
      async pull(c) {
        if (i === 1) await (await fetch(url.replace("/stream-echo", "/seen"), { signal: AbortSignal.timeout(3000) })).text()
        if (i < 3) c.enqueue(new TextEncoder().encode("p" + i++))
        else c.close()
      }
    })
    return (await fetch(url, { method: "POST", body, duplex: "half" })).json()
  }
  export async function wait(url) {
    try { await fetch(url); return "ok" } catch (e) { return [e.name, e.message, e.cause?.message, e.cause?.code ?? null] }
  }
`

async function both(run: (engine: Engine) => Promise<void>) {
  const wasm = Uint8Array.from(await readFile(new URL("../lib/moejs.wasm", import.meta.url)))
  for (const create of [
    () => createMoeJS({ timeoutMs: 10_000 }),
    () => createPortable({ wasm, timeoutMs: 10_000 })
  ]) {
    const engine = await create()
    try {
      await run(engine)
    } finally {
      await engine.close()
    }
  }
}
async function runtime(engine: Engine, network: NetworkOptions = { allowHosts: ["127.0.0.1"] }) {
  const mod = await engine.compile("fetch.js", guest)
  const rt = await engine.newRuntime({ network })
  await rt.load(mod)
  return { rt, call: <T>(name: string, ...args: unknown[]) => rt.call<T>(mod.hook(name), ...args) }
}

it("matches upstream request construction and response details", async () => {
  await both(async (engine) => {
    const { call } = await runtime(engine)
    const echo = await call<Record<string, string>>("json", `${base}/echo?a=1`, {
      method: "POST",
      body: '{"x":1}'
    })
    expect(echo).toMatchObject({
      method: "POST",
      body: '{"x":1}',
      accept: "*/*",
      host: base.slice("http://".length),
      ua: "Go-http-client/1.1",
      ae: "gzip",
      query: "a=1"
    })
    expect(await call("info", `${base}/reason`)).toEqual([
      299,
      "Custom Reason",
      false,
      `${base}/reason`,
      null,
      null,
      null,
      ""
    ])
    expect((await call<unknown[]>("info", `${base}/chunks`)).slice(5)).toEqual([null, null, "ab"])
    expect((await call<unknown[]>("info", `${base}/echo`)).slice(0, 5)).toEqual([
      200,
      "OK",
      false,
      `${base}/echo`,
      "a, b"
    ])
  })
}, 60_000)

it("streams a ReadableStream request body chunked", async () => {
  await both(async (engine) => {
    streamSeen = Promise.withResolvers<void>()
    const { call } = await runtime(engine)
    expect(await call("stream", `${base}/stream-echo`)).toEqual(["p0p1p2", null, "chunked"])
  })
}, 60_000)

it("follows, returns and rejects redirects as upstream", async () => {
  await both(async (engine) => {
    const { call } = await runtime(engine)
    const followed = await call<unknown[]>("info", `${base}/redirect`)
    expect(followed.slice(0, 4)).toEqual([200, "OK", true, `${base}/echo?from=redirect`])
    const manual = await call<unknown[]>("info", `${base}/redirect`, { redirect: "manual" })
    expect([manual[0], manual[6]]).toEqual([302, "/echo?from=redirect"])
    const refused = await call<string[]>("fail", `${base}/redirect`, { redirect: "error" })
    expect(refused.slice(0, 2)).toEqual(["TypeError", "fetch failed"])
    expect(refused[2]).toContain('redirect mode is "error"')
  })
}, 60_000)

it("decodes gzip it asked for and hides the coding", async () => {
  await both(async (engine) => {
    const { call } = await runtime(engine)
    expect(await call("text", `${base}/gzip`)).toBe("hello")
    const info = await call<unknown[]>("info", `${base}/gzip`, {
      headers: { "accept-encoding": "gzip" }
    })
    expect(info[7]).toBe("hello")
  })
}, 60_000)

it("reports network error codes", async () => {
  const closed = createServer()
  closed.listen(0, "127.0.0.1")
  await once(closed, "listening")
  const port = (closed.address() as { port: number }).port
  closed.close()
  await both(async (engine) => {
    const { call } = await runtime(engine)
    const refused = await call<unknown[]>("fail", `http://127.0.0.1:${port}/`)
    expect([refused[0], refused[1], refused[3]]).toEqual([
      "TypeError",
      "fetch failed",
      "ECONNREFUSED"
    ])
    expect(await call("partial", `${base}/reset`)).toEqual([
      "partial",
      "TypeError",
      "terminated",
      "ECONNRESET"
    ])
  })
}, 60_000)

it("applies timeoutMs as the client timeout and carries context causes", async () => {
  await both(async (engine) => {
    const timed = await runtime(engine, { allowHosts: ["127.0.0.1"], timeoutMs: 100 })
    const timedOut = await timed.call<string[]>("wait", `${base}/slow`)
    expect([timedOut[0], timedOut[1], timedOut[3]]).toEqual([
      "TypeError",
      "fetch failed",
      "ETIMEDOUT"
    ])
    expect(timedOut[2]).toContain("Client.Timeout exceeded")
    const { rt, call } = await runtime(engine)
    const network: RuntimeNetwork = rt.network
    const controller = new AbortController()
    await network.setContext(controller.signal)
    const pending = call<string[]>("wait", `${base}/slow`)
    await rt.promiseState(0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort(new Error("run over"))
    expect((await pending).slice(0, 3)).toEqual(["TypeError", "fetch failed", "run over"])
    await network.setContext(AbortSignal.timeout(50))
    const deadline = await call<string[]>("wait", `${base}/slow`)
    expect([deadline[2], deadline[3]]).toEqual(["context deadline exceeded", "ETIMEDOUT"])
    await network.close()
    await network.setContext(new AbortController().signal)
  })
}, 60_000)

it("calls checkRedirect and the jar like http.Client", async () => {
  await both(async (engine) => {
    const via: string[] = []
    const stops = await runtime(engine, {
      allowHosts: ["127.0.0.1"],
      checkRedirect: (request, chain) => {
        via.push(request.url, ...chain.map((item) => item.url))
        return ErrUseLastResponse
      }
    })
    expect((await stops.call<unknown[]>("info", `${base}/redirect`))[0]).toBe(302)
    expect(via).toEqual([`${base}/echo?from=redirect`, `${base}/redirect`])
    const denies = await runtime(engine, { allowHosts: ["127.0.0.1"], checkRedirect: () => false })
    expect((await denies.call<string[]>("fail", `${base}/redirect`)).slice(0, 2)).toEqual([
      "TypeError",
      "fetch failed"
    ])
    const stored: [string, string[]][] = []
    cookies.length = 0
    const jarred = await runtime(engine, {
      allowHosts: ["127.0.0.1"],
      jar: { cookies: () => ["a=b"], setCookies: (url, values) => void stored.push([url, values]) }
    })
    await jarred.call("text", `${base}/set-cookie`)
    expect(cookies).toEqual(["a=b"])
    expect(stored).toEqual([[`${base}/set-cookie`, ["s=1"]]])
  })
}, 60_000)

it("creates a runtime without Web APIs and installs them later", async () => {
  await both(async (engine) => {
    const rt = await engine.newRuntime({ webAPI: false, network: { allowHosts: ["127.0.0.1"] } })
    expect(await rt.evalScript("t.js", "[typeof fetch, typeof URL, typeof setTimeout]")).toEqual([
      "undefined",
      "undefined",
      "function"
    ])
    await rt.network.setContext()
    await rt.installWebAPI()
    expect(await rt.evalScript("t2.js", "typeof fetch")).toBe("function")
    expect(await rt.evalScript("f.js", `fetch("${base}/echo").then((r) => r.status)`)).toBe(200)
    await expect(rt.installWebAPI()).rejects.toThrow("webapi: already installed")
  })
}, 60_000)

it("lets a custom fetch alone enable the network and see the Host header; the platform fetch refuses it", async () => {
  await both(async (engine) => {
    const seen: [string, string][][] = []
    const custom = await runtime(engine, {
      fetch: async (_input, init) => {
        seen.push(init?.headers as [string, string][])
        return new Response("custom", { headers: { "x-redirected": "no" } })
      }
    })
    expect(
      await custom.call("text", "https://anywhere.test/", { headers: { host: "other.example" } })
    ).toBe("custom")
    expect(
      seen[0]!.some(([name, value]) => name.toLowerCase() === "host" && value === "other.example")
    ).toBe(true)
    const platform = await runtime(engine, { allowHosts: ["127.0.0.1", "other.example"] })
    const refused = await platform.call<string[]>("fail", `${base}/echo`, {
      headers: { host: "other.example" }
    })
    expect(refused.slice(0, 2)).toEqual(["TypeError", "fetch failed"])
    expect(refused[2]).toContain("The host's fetch cannot set the Host header")
  })
}, 60_000)

it("accepts a custom fetch's already-followed response as upstream accepts such a RoundTripper", async () => {
  await both(async (engine) => {
    const { call } = await runtime(engine, {
      fetch: async () => {
        const response = new Response("followed")
        Object.defineProperty(response, "redirected", { value: true })
        return response
      }
    })
    expect((await call<unknown[]>("info", "https://start.test/")).slice(0, 4)).toEqual([
      200,
      "OK",
      false,
      "https://start.test/"
    ])
  })
}, 60_000)
