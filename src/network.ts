export interface NetworkRequest {
  url: string
  method: string
  headers: [string, string][]
  /** Aborted when this request or the runtime is closed. */
  signal?: AbortSignal
}

/** http.CookieJar, kept by the host. */
export interface CookieJar {
  /** The "name=value" pairs to send to url. */
  cookies(url: string): string[] | Promise<string[]>
  /** The Set-Cookie values a response from url carried. */
  setCookies(url: string, cookies: string[]): void | Promise<void>
}

/** http.ErrUseLastResponse: returned or thrown by checkRedirect to stop at the redirect response. */
export const ErrUseLastResponse = Object.freeze(new Error("net/http: use last response"))

export interface NetworkOptions {
  allowHosts?: string[]
  /** Called before every request, including each redirect. False denies the request. */
  allow?: (request: NetworkRequest) => boolean | void | Promise<boolean | void>
  /** The transport; like a non-nil Client with a nil Allow, it alone enables the network. */
  fetch?: typeof globalThis.fetch
  /** Parent context: cancellation permanently cancels this installation's requests. */
  signal?: AbortSignal
  /** http.Client.Timeout: the whole request, body included. */
  timeoutMs?: number
  /** http.Client.CheckRedirect, called after webapi's own checks in follow mode. False denies the hop. */
  checkRedirect?: (request: NetworkRequest, via: NetworkRequest[]) => unknown
  /** http.Client.Jar. */
  jar?: CookieJar
}

export interface NetworkMessage {
  type: "networkRequest"
  id: number
  kind: "allow" | "fetch" | "read" | "write" | "cancel" | "checkRedirect" | "cookies" | "setCookies"
  request?: Omit<NetworkRequest, "signal">
  init?: {
    method?: string
    headers?: [string, string][]
    /** Transport defaults (User-Agent, Accept-Encoding); the host adds them outside browsers. */
    defaults?: [string, string][]
    body?: Uint8Array<ArrayBuffer>
    /** The body follows as "write" messages whose bodyId is this message's id. */
    stream?: boolean
  }
  bodyId?: number
  chunk?: Uint8Array<ArrayBuffer>
  /** write: the request body failed with this message. */
  error?: string
  via?: Omit<NetworkRequest, "signal">[]
  cookies?: string[]
}

/** The one error shape network replies carry; code is an errno webapi maps. */
export interface NetworkError {
  message: string
  name?: string
  code?: string
}

export function networkError(error: unknown): NetworkError {
  if (typeof error !== "object" || error === null || typeof (error as Error).message !== "string")
    return { message: String(error) }
  const { message, name, code } = error as Error & { code?: unknown }
  const cause = (error as { cause?: unknown }).cause as
    | { message?: unknown; code?: unknown }
    | undefined
  const causeMessage =
    typeof cause?.message === "string" && cause.message !== message ? cause.message : ""
  const errno =
    typeof cause?.code === "string"
      ? cause.code
      : typeof code === "string"
        ? code
        : name === "TimeoutError"
          ? "ETIMEDOUT"
          : undefined
  return {
    message: causeMessage ? `${message}: ${causeMessage}` : message,
    name,
    ...(errno && { code: errno })
  }
}

export function abortCause(reason: unknown): { name?: string; message: string } {
  if (
    typeof reason === "object" &&
    reason !== null &&
    typeof (reason as Error).message === "string"
  )
    return { name: (reason as Error).name, message: (reason as Error).message }
  return { message: String(reason) }
}

/** Whether the host fetch already decoded a Content-Encoding value. */
export function hostDecodes(value: string, onWorkerd: boolean): boolean {
  const codings = value
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== "identity")
  if (onWorkerd) return codings.length === 1 && (codings[0] === "gzip" || codings[0] === "br")
  return codings.every((coding) => ["gzip", "x-gzip", "deflate", "br", "zstd"].includes(coding))
}

export interface Platform {
  workerd: boolean
  browser: boolean
  /** ReadableStream request bodies with duplex "half". */
  streams: boolean
  init: { cache?: RequestCache; referrer?: string }
}

function accepts(init: RequestInit) {
  try {
    new Request("http://moejs.invalid/", init)
    return true
  } catch {
    return false
  }
}

let platform: Platform | undefined
export function hostPlatform(): Platform {
  if (platform) return platform
  const host = globalThis as {
    navigator?: { userAgent?: string }
    process?: { versions?: { node?: unknown } }
    document?: unknown
    WorkerGlobalScope?: unknown
  }
  // workerd also defines WorkerGlobalScope, so it is tested first.
  const workerd = host.navigator?.userAgent === "Cloudflare-Workers"
  const node = !workerd && typeof host.process?.versions?.node === "string"
  const browser =
    !workerd &&
    !node &&
    (typeof host.document === "object" || typeof host.WorkerGlobalScope === "function")
  const init: Platform["init"] = {}
  if (typeof Request === "function") {
    // Upstream has no HTTP cache and sends no Referer; old workerd compat dates refuse cache.
    if (accepts({ cache: "no-store" })) init.cache = "no-store"
    if (accepts({ referrer: "" })) init.referrer = ""
  }
  return (platform = { workerd, browser, streams: node || workerd, init })
}

export function networkWireOptions(options?: NetworkOptions) {
  return {
    allowHosts: options?.allowHosts ?? [],
    allowHostsSet: options?.allowHosts !== undefined,
    allowCallback: !!options?.allow,
    customFetch: !!options?.fetch,
    timeoutMs: options?.timeoutMs ?? 0,
    checkRedirect: !!options?.checkRedirect,
    jar: !!options?.jar
  }
}

interface Upload {
  stream?: ReadableStream<Uint8Array>
  buffered?: Promise<Uint8Array<ArrayBuffer>>
  write(chunk: Uint8Array | undefined, error?: string): Promise<void>
  fail(reason: unknown): void
}

// Each write resolves once the platform took the chunk, so Go never reads ahead of it.
function streamingUpload(done: () => void): Upload {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let demand = Promise.withResolvers<void>()
  demand.promise.catch(() => {})
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (c) => void (controller = c),
      pull: () => demand.resolve(),
      cancel: (reason: unknown) => demand.reject(reason ?? new Error("Network request canceled"))
    },
    { highWaterMark: 0 }
  )
  return {
    stream,
    async write(chunk, error) {
      if (error !== undefined) {
        controller.error(new TypeError(error))
        return done()
      }
      if (!chunk) {
        controller.close()
        return done()
      }
      await demand.promise
      // pull() may run synchronously inside enqueue.
      demand = Promise.withResolvers<void>()
      demand.promise.catch(() => {})
      controller.enqueue(chunk)
    },
    fail(reason) {
      try {
        controller.error(reason)
      } catch {
        /* Already closed. */
      }
      demand.reject(reason)
    }
  }
}

function bufferedUpload(done: () => void): Upload {
  const chunks: Uint8Array[] = []
  const result = Promise.withResolvers<Uint8Array<ArrayBuffer>>()
  result.promise.catch(() => {})
  return {
    buffered: result.promise,
    async write(chunk, error) {
      if (error !== undefined) {
        result.reject(new TypeError(error))
        return done()
      }
      if (chunk) {
        chunks.push(chunk)
        return
      }
      const body = new Uint8Array(chunks.reduce((size, item) => size + item.length, 0))
      let offset = 0
      for (const item of chunks) {
        body.set(item, offset)
        offset += item.length
      }
      result.resolve(body)
      done()
    },
    fail: (reason) => result.reject(reason)
  }
}

/** Owns host-side resources; only serializable messages cross the worker boundary. */
export class NetworkHost {
  private readonly fetch: typeof globalThis.fetch | undefined
  private readonly controllers = new Map<number, AbortController>()
  private readonly readers = new Map<number, ReadableStreamDefaultReader<Uint8Array>>()
  private readonly uploads = new Map<number, Upload>()
  private closed = false

  constructor(
    private readonly options: NetworkOptions = {},
    private readonly platform = hostPlatform()
  ) {
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis)
  }

  async handle(message: NetworkMessage): Promise<unknown> {
    const { id, bodyId } = message
    if (message.kind === "cancel") {
      if (bodyId !== undefined) await this.cancel(bodyId)
      return null
    }
    if (this.closed) throw new Error("MoeJS network is closed")
    if (message.kind === "write") {
      const upload = bodyId === undefined ? undefined : this.uploads.get(bodyId)
      if (!upload) throw new Error("Network request body is closed")
      await upload.write(message.chunk, message.error)
      return null
    }
    if (message.kind === "read") {
      const reader = bodyId === undefined ? undefined : this.readers.get(bodyId)
      if (!reader) throw new Error("Network response body is closed")
      const controller = this.controllers.get(bodyId!)
      try {
        const chunk = await reader.read()
        // reader.cancel() resolves an outstanding read as EOF; an aborted
        // request must remain a network error rather than a successful body.
        if (controller?.signal.aborted) throw new Error("Network request canceled")
        if (chunk.done) this.release(bodyId!)
        const value: unknown = chunk.value
        if (value !== undefined && !(value instanceof Uint8Array))
          throw new TypeError("Network response body chunks must be Uint8Array")
        // A view would carry its whole buffer to the worker; send its bytes.
        return {
          done: chunk.done,
          value: value && value.byteLength !== value.buffer.byteLength ? value.slice() : value
        }
      } catch (error) {
        await this.cancel(bodyId!)
        throw error
      }
    }
    if (!message.request) throw new Error("Missing network request")
    if (message.kind === "cookies") {
      const cookies: unknown = (await this.options.jar?.cookies(message.request.url)) ?? []
      if (!Array.isArray(cookies) || cookies.some((cookie) => typeof cookie !== "string"))
        throw new TypeError("jar.cookies must return strings")
      return cookies
    }
    if (message.kind === "setCookies") {
      await this.options.jar?.setCookies(message.request.url, message.cookies ?? [])
      return null
    }
    const controller = new AbortController()
    this.controllers.set(id, controller)
    // Registered before any await: the first write can arrive right behind this message.
    const init = message.init ?? {
      method: message.request.method,
      headers: message.request.headers
    }
    let upload: Upload | undefined
    if (message.kind === "fetch" && init.stream) {
      const done = () => this.uploads.delete(id)
      upload = this.platform.streams ? streamingUpload(done) : bufferedUpload(done)
      this.uploads.set(id, upload)
    }
    try {
      if (message.kind === "allow" || message.kind === "checkRedirect") {
        const request = { ...message.request, signal: controller.signal }
        if (message.kind === "allow") {
          const allowed = await this.options.allow?.(request)
          if (allowed === false) throw new Error("Network request denied by host policy")
          this.release(id)
          return null
        }
        let verdict: unknown
        try {
          verdict = await this.options.checkRedirect?.(request, message.via ?? [])
        } catch (error) {
          if (error !== ErrUseLastResponse) throw error
          verdict = error
        }
        this.release(id)
        if (verdict === ErrUseLastResponse) return { useLastResponse: true }
        if (verdict === false) throw new Error("Network redirect denied by host policy")
        return null
      }
      if (!this.fetch) throw new Error("The host does not provide fetch")
      const headers = [
        ...(init.headers ?? []),
        ...(this.platform.browser ? [] : (init.defaults ?? []))
      ]
      // The platform fetch would silently send a virtual-host request to the URL's host instead.
      if (!this.options.fetch && headers.some(([name]) => name.toLowerCase() === "host"))
        throw new Error("The host's fetch cannot set the Host header")
      const streamed = upload?.stream !== undefined
      const response = await this.fetch(message.request.url, {
        method: init.method,
        headers,
        body: upload ? (streamed ? upload.stream : await upload.buffered) : init.body,
        ...(streamed && { duplex: "half" }),
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
        ...this.platform.init
      } as RequestInit & { duplex?: "half" })
      if (controller.signal.aborted || this.closed) {
        await response.body?.cancel().catch(() => {})
        throw new Error("Network request canceled")
      }
      // Per-hop policy needs the 3xx itself, which a browser hides.
      if (response.type === "opaqueredirect") {
        await response.body?.cancel().catch(() => {})
        throw new Error(
          "webapi: the host's fetch cannot expose redirect responses (opaqueredirect)"
        )
      }
      if (response.body) this.readers.set(id, response.body.getReader())
      else this.release(id)
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers),
        url: response.url,
        bodyId: response.body ? id : undefined,
        decoded: hostDecodes(response.headers.get("content-encoding") ?? "", this.platform.workerd)
      }
    } catch (error) {
      await this.cancel(id)
      throw error
    }
  }

  private release(id: number) {
    this.readers.delete(id)
    this.controllers.delete(id)
  }

  private async cancel(id: number) {
    this.controllers.get(id)?.abort()
    const upload = this.uploads.get(id)
    this.uploads.delete(id)
    upload?.fail(new Error("Network request canceled"))
    const reader = this.readers.get(id)
    this.release(id)
    await reader?.cancel().catch(() => {})
  }

  close() {
    this.closed = true
    for (const id of new Set([...this.controllers.keys(), ...this.uploads.keys()]))
      void this.cancel(id)
  }
}

export class RuntimeNetwork {
  private readonly host: NetworkHost
  private readonly contexts = new Map<number, { signal: AbortSignal; listener: () => void }>()
  private nextContext = 0
  private currentContext: number | null = null
  private initialized = false
  private disposed = false
  private closing?: Promise<void>
  private readonly parentAbort: () => void

  constructor(
    private readonly scope: { control<T>(op: string, payload?: object): Promise<T> },
    private readonly options: NetworkOptions = {}
  ) {
    this.host = new NetworkHost(options)
    this.parentAbort = () => {
      if (this.initialized && !this.disposed) {
        void this.scope
          .control("networkCancelParent", { reason: abortCause(options.signal!.reason) })
          .catch(() => {})
      }
    }
    options.signal?.addEventListener("abort", this.parentAbort, { once: true })
  }

  async initialize(): Promise<void> {
    this.initialized = true
    if (this.options.signal?.aborted)
      await this.scope.control("networkCancelParent", {
        reason: abortCause(this.options.signal.reason)
      })
  }

  handle(message: NetworkMessage): Promise<unknown> {
    return this.host.handle(message)
  }

  /** API.SetContext: a parent for the fetches started from now on; none leaves the installation's own. */
  async setContext(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return
    const id = signal ? ++this.nextContext : null
    this.currentContext = id
    await this.scope.control("networkSetContext", { networkContext: id })
    if (signal && id !== null) {
      const listener = () => {
        void this.cancel(id, signal.reason).catch(() => {})
      }
      this.contexts.set(id, { signal, listener })
      signal.addEventListener("abort", listener, { once: true })
      if (signal.aborted) await this.cancel(id, signal.reason)
    }
  }

  async cancelContext(): Promise<void> {
    if (this.currentContext !== null) await this.cancel(this.currentContext)
  }

  private async cancel(id: number, reason?: unknown): Promise<void> {
    const context = this.contexts.get(id)
    context?.signal.removeEventListener("abort", context.listener)
    this.contexts.delete(id)
    if (!this.disposed)
      await this.scope.control("networkCancelContext", {
        networkContext: id,
        reason: reason === undefined ? undefined : abortCause(reason)
      })
  }

  close(): Promise<void> {
    this.closing ??= this.scope.control<void>("networkClose").finally(() => this.dispose())
    return this.closing
  }

  dispose(): void {
    this.disposed = true
    this.options.signal?.removeEventListener("abort", this.parentAbort)
    for (const context of this.contexts.values()) {
      context.signal.removeEventListener("abort", context.listener)
    }
    this.contexts.clear()
    this.host.close()
  }
}
