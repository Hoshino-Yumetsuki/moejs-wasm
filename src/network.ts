export interface NetworkRequest {
  url: string
  method: string
  headers: [string, string][]
  /** Aborted when this request or the runtime is closed. */
  signal?: AbortSignal
}

export interface NetworkOptions {
  allowHosts?: string[]
  /** Called before every request, including each redirect. False denies the request. */
  allow?: (request: NetworkRequest) => boolean | void | Promise<boolean | void>
  fetch?: typeof globalThis.fetch
  /** Parent context: cancellation permanently cancels this installation's requests. */
  signal?: AbortSignal
}

export interface NetworkMessage {
  type: "networkRequest"
  id: number
  kind: "allow" | "fetch" | "read" | "cancel"
  request?: Omit<NetworkRequest, "signal">
  init?: { method?: string; headers?: [string, string][]; body?: number[] }
  bodyId?: number
}

export function networkWireOptions(options?: NetworkOptions) {
  return { allowHosts: options?.allowHosts ?? [], allowCallback: !!options?.allow }
}

/** Owns host-side resources; only serializable messages cross the worker boundary. */
export class NetworkHost {
  private readonly fetch: typeof globalThis.fetch | undefined
  private readonly controllers = new Map<number, AbortController>()
  private readonly readers = new Map<number, ReadableStreamDefaultReader<Uint8Array>>()
  private closed = false

  constructor(private readonly options: NetworkOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis)
  }

  async handle(message: NetworkMessage): Promise<unknown> {
    const { id, bodyId } = message
    if (message.kind === "cancel") {
      if (bodyId !== undefined) await this.cancel(bodyId)
      return null
    }
    if (this.closed) throw new Error("MoeJS network is closed")
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
        return { done: chunk.done, value: chunk.value ? Array.from(chunk.value) : undefined }
      } catch (error) {
        await this.cancel(bodyId!)
        throw error
      }
    }
    const controller = new AbortController()
    this.controllers.set(id, controller)
    try {
      if (!message.request) throw new Error("Missing network request")
      if (message.kind === "allow") {
        const allowed = await this.options.allow?.({
          ...message.request,
          signal: controller.signal
        })
        if (allowed === false) throw new Error("Network request denied by host policy")
        this.release(id)
        return null
      }
      if (!this.fetch) throw new Error("The host does not provide fetch")
      const response = await this.fetch(message.request.url, {
        ...message.init,
        body: message.init?.body === undefined ? undefined : new Uint8Array(message.init.body),
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit"
      })
      if (controller.signal.aborted || this.closed) {
        await response.body?.cancel().catch(() => {})
        throw new Error("Network request canceled")
      }
      // Never allow a host implementation to silently bypass per-hop policy.
      if (response.type === "opaqueredirect" || response.redirected) {
        await response.body?.cancel().catch(() => {})
        throw new Error("The host cannot expose a manual redirect response")
      }
      if (response.body) this.readers.set(id, response.body.getReader())
      else this.release(id)
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        url: response.url,
        bodyId: response.body ? id : undefined
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
    const reader = this.readers.get(id)
    this.release(id)
    await reader?.cancel().catch(() => {})
  }

  close() {
    this.closed = true
    for (const id of this.controllers.keys()) void this.cancel(id)
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
        void this.scope.control("networkCancelParent").catch(() => {})
      }
    }
    options.signal?.addEventListener("abort", this.parentAbort, { once: true })
  }

  async initialize(): Promise<void> {
    this.initialized = true
    if (this.options.signal?.aborted) await this.scope.control("networkCancelParent")
  }

  handle(message: NetworkMessage): Promise<unknown> {
    return this.host.handle(message)
  }

  async setContext(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error("MoeJS network is closed")
    const id = signal ? ++this.nextContext : null
    this.currentContext = id
    await this.scope.control("networkSetContext", { networkContext: id })
    if (signal && id !== null) {
      const listener = () => {
        void this.cancel(id).catch(() => {})
      }
      this.contexts.set(id, { signal, listener })
      signal.addEventListener("abort", listener, { once: true })
      if (signal.aborted) await this.cancel(id)
    }
  }

  async cancelContext(): Promise<void> {
    if (this.currentContext !== null) await this.cancel(this.currentContext)
  }

  private async cancel(id: number): Promise<void> {
    const context = this.contexts.get(id)
    context?.signal.removeEventListener("abort", context.listener)
    this.contexts.delete(id)
    if (!this.disposed) await this.scope.control("networkCancelContext", { networkContext: id })
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
