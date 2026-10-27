import type { Adapter, WorkerEndpoint, WorkerMessage } from "./adapter"
import {
  decode,
  encode,
  errorPayload,
  failure,
  MoeJSError,
  TimeoutError,
  type ErrorPayload,
  type HostFunction,
  type WireValue
} from "./wire"

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

type Timer = number | NodeJS.Timeout
interface Pending {
  resolve(value: unknown): void
  reject(reason: unknown): void
  timer?: Timer
  signal?: AbortSignal
  abort?: () => void
  sent: boolean
}

/** One scoped codec and operation queue per isolated Go endpoint. */
export class Transport {
  private endpoint?: WorkerEndpoint
  private workerReady = false
  private readonly pending = new Map<number, Pending>()
  private readonly callbacks = new Map<number, HostFunction>()
  private readonly callbackIds = new WeakMap<HostFunction, number>()
  private readonly callbackCancellations = new Set<(reason: unknown) => void>()
  private nextId = 1
  private nextCallbackId = 1
  private nextSettlementId = -1
  private tail: Promise<unknown> = Promise.resolve()
  private stopped?: MoeJSError
  private termination: Promise<void> = Promise.resolve()
  private callbackDepth = 0
  private callbackGeneration = 0
  private recoverable = false
  moduleRequest?: (
    message: Extract<WorkerMessage, { type: "moduleRequest" }>,
    signal: AbortSignal
  ) => Promise<object>
  networkRequest?: (message: Extract<WorkerMessage, { type: "networkRequest" }>) => Promise<unknown>
  event?: (message: Extract<WorkerMessage, { type: "event" }>) => void
  readonly ready: Promise<void>
  private readonly readyGate = Promise.withResolvers<void>()
  private readonly startupTimer: Timer

  constructor(
    module: WebAssembly.Module,
    adapter: Adapter,
    workerURL: string | URL | undefined,
    private readonly timeoutMs: number
  ) {
    this.ready = this.readyGate.promise
    void this.ready.catch(() => undefined)
    this.startupTimer = setTimeout(() => void this.stop(new TimeoutError(timeoutMs)), timeoutMs)
    void this.start(module, adapter, workerURL).catch((error: unknown) =>
      this.stop(new MoeJSError(errorPayload(error, "internal")))
    )
  }

  private async start(module: WebAssembly.Module, adapter: Adapter, workerURL?: string | URL) {
    const endpoint = await adapter.createWorker(
      module,
      { workerURL, timeoutMs: this.timeoutMs },
      {
        message: (message) => this.receive(message),
        error: (error) => void this.stop(new MoeJSError(errorPayload(error, "internal")))
      }
    )
    this.endpoint = endpoint
    if (this.stopped) await this.terminateEndpoint()
    else if (this.workerReady) this.readyGate.resolve()
  }

  private terminateEndpoint(): Promise<void> {
    const endpoint = this.endpoint
    this.endpoint = undefined
    if (endpoint) {
      try {
        this.termination = Promise.resolve(endpoint.terminate()).catch(() => undefined)
      } catch {
        /* Already disconnected. */
      }
    }
    return this.termination
  }

  private finish(id: number): Pending | undefined {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort)
    return pending
  }

  private receive(message: WorkerMessage): void {
    if (this.stopped) return
    switch (message.type) {
      case "ready":
        clearTimeout(this.startupTimer)
        this.workerReady = true
        if (this.endpoint) this.readyGate.resolve()
        break
      case "fatal":
        void this.stop(new MoeJSError(message.error, this))
        break
      case "hostCall":
        void this.hostCall(message)
        break
      case "moduleRequest":
        void this.resolveModule(message)
        break
      case "networkRequest":
        void this.resolveNetwork(message)
        break
      case "event":
        this.event?.(message)
        break
      case "response": {
        const pending = this.finish(message.id)
        if (!pending) return
        if (message.ok) pending.resolve(message.value)
        else
          pending.reject(
            new MoeJSError(
              message.error ?? {
                kind: "bridge",
                name: "MoeJSError",
                message: "Missing worker error payload"
              },
              this
            )
          )
      }
    }
  }

  encode(value: unknown): WireValue {
    this.assertUsable()
    return encode(
      value,
      (fn) => {
        const previous = this.callbackIds.get(fn)
        if (previous) return previous
        const id = this.nextCallbackId++
        this.callbackIds.set(fn, id)
        this.callbacks.set(id, fn)
        return id
      },
      this
    )
  }

  decode(value: WireValue): unknown {
    return decode(value, this)
  }
  encodeGlobal(value: unknown): WireValue {
    return this.encode(value)
  }

  private async hostCall(message: Extract<WorkerMessage, { type: "hostCall" }>): Promise<void> {
    const callback = this.callbacks.get(message.callbackId)
    const generation = this.callbackGeneration
    this.callbackDepth++
    let payload: { callId: number; value?: WireValue; error?: ErrorPayload }
    try {
      if (!callback) throw failure("host", "Unknown host callback")
      const result = await this.waitForCallback(() =>
        callback.apply(
          message.thisValue ? this.decode(message.thisValue) : undefined,
          message.args.map((arg) => this.decode(arg))
        )
      )
      payload = { callId: message.id, value: this.encode(result) }
    } catch (error) {
      payload = { callId: message.id, error: errorPayload(error) }
      try {
        if (error instanceof MoeJSError) {
          if (error.value !== undefined) payload.error!.value = this.encode(error.value)
          if (error.reason !== undefined) payload.error!.reason = this.encode(error.reason)
        }
      } catch (encodingError) {
        payload.error = errorPayload(encodingError)
      }
    } finally {
      if (generation === this.callbackGeneration) this.callbackDepth--
    }
    if (!this.stopped && generation === this.callbackGeneration) this.sendReply("settle", payload)
  }

  private sendReply(op: string, payload: object): void {
    try {
      this.endpoint?.postMessage({ type: "request", id: this.nextSettlementId--, op, payload })
    } catch (error) {
      void this.stop(new MoeJSError(errorPayload(error, "bridge")))
    }
  }

  private async waitForCallback<T>(
    operation: (signal: AbortSignal) => T | PromiseLike<T>
  ): Promise<T> {
    const cancelled = Promise.withResolvers<never>()
    const controller = new AbortController()
    const cancel = (reason: unknown) => {
      controller.abort(reason)
      cancelled.reject(reason)
    }
    this.callbackCancellations.add(cancel)
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        cancelled.promise
      ])
    } finally {
      this.callbackCancellations.delete(cancel)
    }
  }

  private async resolveModule(message: Extract<WorkerMessage, { type: "moduleRequest" }>) {
    let payload: object
    const generation = this.callbackGeneration
    this.callbackDepth++
    try {
      if (!this.moduleRequest) throw failure("bridge", "No module importer is configured")
      payload = {
        id: message.id,
        ...(await this.waitForCallback((signal) => this.moduleRequest!(message, signal)))
      }
    } catch (error) {
      payload = { id: message.id, error: errorPayload(error) }
    } finally {
      if (generation === this.callbackGeneration) this.callbackDepth--
    }
    if (!this.stopped && generation === this.callbackGeneration)
      this.sendReply("moduleResult", payload)
  }

  private async resolveNetwork(message: Extract<WorkerMessage, { type: "networkRequest" }>) {
    let payload: object
    try {
      if (!this.networkRequest) throw failure("bridge", "No host network transport is configured")
      payload = { id: message.id, value: await this.networkRequest(message) }
    } catch (error) {
      payload = { id: message.id, error: error instanceof Error ? error.message : String(error) }
    }
    if (!this.stopped) this.sendReply("networkResult", payload)
  }

  assertUsable(): void {
    if (this.stopped) throw this.stopped
  }
  get isStopped(): boolean {
    return Boolean(this.stopped)
  }

  /** Runtime interrupts are recoverable; compiler endpoints remain disposable. */
  enableRecovery(): void {
    this.recoverable = true
  }

  interrupt(reason: unknown = "MoeJS runtime was interrupted"): void {
    this.assertUsable()
    const value = this.encode(reason)
    this.rejectInterrupted(reason, value)
    this.sendReply("interrupt", { interruptReason: value })
  }

  private rejectInterrupted(reason: unknown, value: WireValue): void {
    const error = new MoeJSError(
      {
        kind: "interrupted",
        name: "InterruptedError",
        message: errorPayload(reason).message,
        code: "ERR_INTERRUPTED",
        value,
        reason: value
      },
      this
    )
    this.rejectPending(error)
  }

  private rejectPending(error: unknown) {
    this.callbackGeneration++
    this.callbackDepth = 0
    for (const cancel of this.callbackCancellations) cancel(error)
    this.callbackCancellations.clear()
    for (const id of this.pending.keys()) this.finish(id)?.reject(error)
  }

  request<T>(op: string, payload: object = {}, options: RequestOptions = {}): Promise<T> {
    return this.enqueue<T>(op, payload, options, this.callbackDepth > 0)
  }

  /** Control and Promise settlement must progress while an outer call is awaiting. */
  control<T>(op: string, payload: object = {}, options: RequestOptions = {}): Promise<T> {
    if (
      this.callbackDepth &&
      ["loopRun", "loopStop", "loopStart", "loopTerminate", "clearInterrupt"].includes(op)
    )
      return Promise.reject(
        failure("host", "A runtime callback cannot wait for its own event loop to stop")
      )
    if (op === "interrupt" && !this.stopped) {
      const value = (payload as { interruptReason: WireValue }).interruptReason
      this.rejectInterrupted(this.decode(value), value)
    }
    return this.enqueue<T>(op, payload, options, true)
  }

  private enqueue<T>(
    op: string,
    payload: object,
    options: RequestOptions,
    immediate: boolean
  ): Promise<T> {
    if (this.stopped) return Promise.reject(this.stopped)
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
      return Promise.reject(
        new RangeError("timeoutMs must be positive, finite, and at most 2147483647")
      )
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const pending: Pending = {
      resolve: (value) => resolve(value as T),
      reject,
      sent: false,
      signal: options.signal
    }
    const cancel = (error: unknown) => {
      if (!this.finish(id)) return
      reject(error)
      if (!pending.sent) return
      if (!this.recoverable) {
        void this.stop(error instanceof MoeJSError ? error : failure("interrupted", String(error)))
        return
      }
      this.rejectPending(error)
      this.sendReply("interrupt", {
        interruptReason: this.encode(error)
      })
    }
    if (options.signal) {
      pending.abort = () => cancel(options.signal!.reason)
      options.signal.addEventListener("abort", pending.abort, { once: true })
    }
    this.pending.set(id, pending)
    const previous = immediate ? Promise.resolve() : this.tail
    if (!immediate) this.tail = promise.catch(() => undefined)
    void previous
      .then(() => this.ready)
      .then(() => {
        if (this.stopped || !this.pending.has(id)) return
        pending.sent = true
        pending.timer = setTimeout(() => cancel(new TimeoutError(timeoutMs)), timeoutMs)
        this.endpoint?.postMessage({
          type: "request",
          id,
          op,
          payload: { ...payload, reentrant: immediate }
        })
      })
      .catch((error: unknown) => {
        this.finish(id)?.reject(error)
      })
    return promise
  }

  stop(reason: MoeJSError = failure("closed", "MoeJS runtime is closed")): Promise<void> {
    if (this.stopped) return this.termination
    this.stopped = reason
    clearTimeout(this.startupTimer)
    this.readyGate.reject(reason)
    this.rejectPending(reason)
    this.callbacks.clear()
    this.moduleRequest = undefined
    this.networkRequest = undefined
    this.event = undefined
    return this.terminateEndpoint()
  }
}
