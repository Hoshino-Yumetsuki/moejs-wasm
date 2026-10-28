import type { Adapter, WorkerEndpoint, WorkerMessage } from "./adapter"
import { networkError } from "./network"
import { hostWire } from "./handles"
import { collectTemporaries, expireValues, Value } from "./value"
import {
  decode,
  encode,
  errorPayload,
  failure,
  interruptMessage,
  loopRunning,
  moeJSError,
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
  deadline?: Deadline
  scaled: boolean
  signal?: AbortSignal
  abort?: () => void
  sent: boolean
}

export const defaultTimeoutMs = 1000
const maxTimeoutMs = 2_147_483_647
export function checkTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > maxTimeoutMs)
    throw new RangeError("timeoutMs must be positive, finite, and at most 2147483647")
  return value
}

interface Deadline {
  extend(ms: number): void
  clear(): void
}
function deadline(ms: number, expire: () => void): Deadline {
  let at = Date.now() + ms
  let timer = setTimeout(expire, ms)
  return {
    extend(more) {
      at += more
      clearTimeout(timer)
      timer = setTimeout(expire, Math.min(maxTimeoutMs, at - Date.now()))
    },
    clear: () => clearTimeout(timer)
  }
}

type CodePayload = {
  source?: string
  code?: string
  earlyCode?: string
  params?: string
  body?: string
  module?: CodePayload
  modules?: CodePayload[]
}
function codeLength(payload: object): number {
  const { source, code, earlyCode, params, body, module, modules } = payload as CodePayload
  let length =
    (source?.length ?? 0) +
    (code?.length ?? 0) +
    (earlyCode?.length ?? 0) +
    (params?.length ?? 0) +
    (body?.length ?? 0) +
    (module ? codeLength(module) : 0)
  for (const item of modules ?? []) length += codeLength(item)
  return length
}
function codeMs(payload: object): number {
  const length = codeLength(payload)
  return length < 1024 ? 0 : Math.ceil(length / 1024)
}

function fatal(error: unknown, scope?: Transport): MoeJSError {
  return new MoeJSError({ ...errorPayload(error, "fatal"), kind: "fatal" }, scope)
}

/** A sibling of an aborted compile, to be re-issued on a new compiler endpoint. */
export class EndpointRecycled extends MoeJSError {
  constructor() {
    super({ kind: "closed", name: "MoeJSError", message: "MoeJS compiler endpoint was recycled" })
  }
}
const compileOps = new Set(["compile", "compileScript", "compileFunction"])
// Callback ids an encoded wire registered, until the message carrying it is posted.
const stagedIds = Symbol("moejs.stagedIds")
const weakCallbacks = typeof FinalizationRegistry === "function"

// Go polls this word while guest code runs; without cross-origin isolation interrupts land at yields.
function sharedInterruptWord(): Int32Array | undefined {
  if (
    typeof SharedArrayBuffer !== "function" ||
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === false
  )
    return
  return new Int32Array(new SharedArrayBuffer(4))
}

function isWire(value: object): boolean {
  return typeof (value as { t?: unknown }).t === "string"
}

type Then = (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => unknown
function thenOf(value: unknown): Then | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return
  const then = (value as { then?: unknown }).then
  return typeof then === "function" ? (then as Then) : undefined
}

/** One scoped codec and operation queue per isolated Go endpoint. */
export class Transport {
  private endpoint?: WorkerEndpoint
  private workerReady = false
  private readonly pending = new Map<number, Pending>()
  private readonly callbacks = new Map<number, HostFunction>()
  // Posted occurrences per callback id; Go's released event frees one each.
  private readonly callbackPosts = new Map<number, number>()
  private readonly stagedWires = weakCallbacks
    ? new FinalizationRegistry<number[]>((ids) => this.unstage(ids))
    : undefined
  private staged = 0
  private readonly callbackCancellations = new Set<(reason: unknown) => void>()
  private nextId = 1
  private nextCallbackId = 1
  private nextSettlementId = -1
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private stopped?: MoeJSError
  private termination: Promise<void> = Promise.resolve()
  private callbackDepth = 0
  private callbackGeneration = 0
  private recoverable = false
  private recyclable = false
  private readonly hostIds = new WeakMap<object, number>()
  private readonly hostRefs = new Map<number, WeakRef<object>>()
  private nextHostId = 1
  private sweepAt = 64
  private releases?: Record<"value" | "native" | "script" | "module", number[]>
  private readonly interruptWord = sharedInterruptWord()
  private interruptSeq = 0
  private interruptWordSent = false
  moduleRequest?: (
    message: Extract<WorkerMessage, { type: "moduleRequest" }>,
    signal: AbortSignal
  ) => Promise<object>
  networkRequest?: (message: Extract<WorkerMessage, { type: "networkRequest" }>) => Promise<unknown>
  readonly ready: Promise<void>
  private readonly readyGate = Promise.withResolvers<void>()
  private readonly stopGate = Promise.withResolvers<void>()
  readonly closed = this.stopGate.promise
  private startupTimer: Timer
  private readonly startedAt = Date.now()
  readonly held = new Set<number>()

  constructor(
    module: WebAssembly.Module,
    adapter: Adapter,
    workerURL: string | URL | undefined,
    private timeoutMs?: number
  ) {
    this.ready = this.readyGate.promise
    void this.ready.catch(() => undefined)
    const startup = timeoutMs ?? defaultTimeoutMs
    this.startupTimer = setTimeout(() => void this.stop(new TimeoutError(startup)), startup)
    void this.start(module, adapter, workerURL).catch((error: unknown) => this.stop(fatal(error)))
  }

  private async start(module: WebAssembly.Module, adapter: Adapter, workerURL?: string | URL) {
    const endpoint = await adapter.createWorker(
      module,
      { workerURL, timeoutMs: this.timeoutMs ?? defaultTimeoutMs },
      {
        message: (message) => this.receive(message),
        error: (error) => void this.stop(fatal(error))
      }
    )
    this.endpoint = endpoint
    if (this.stopped) await this.terminateEndpoint()
    else if (this.workerReady) this.announceReady()
  }

  private get isReady(): boolean {
    return this.workerReady && this.endpoint !== undefined
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

  private announceReady(): void {
    if (this.interruptWord && !this.interruptWordSent && this.endpoint) {
      this.interruptWordSent = true
      try {
        this.endpoint.postMessage({
          type: "request",
          id: this.nextSettlementId--,
          op: "interruptWord",
          payload: { buffer: this.interruptWord.buffer }
        })
      } catch {
        // A DataCloneError without cross-origin isolation: interrupts land at yields.
      }
    }
    this.readyGate.resolve()
  }

  /** Posts a request; an interrupt carries its seq first and publishes it only once posted. */
  private post(id: number, op: string, payload: object): void {
    const endpoint = this.endpoint
    if (!endpoint) return
    if (op !== "interrupt") return endpoint.postMessage({ type: "request", id, op, payload })
    const seq = (this.interruptSeq + 1) | 0
    endpoint.postMessage({ type: "request", id, op, payload: { interruptSeq: seq, ...payload } })
    this.interruptSeq = seq
    if (this.interruptWord) Atomics.store(this.interruptWord, 0, seq)
  }

  private finish(id: number): Pending | undefined {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.deadline?.clear()
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort)
    return pending
  }

  private receive(message: WorkerMessage): void {
    if (this.stopped) return
    switch (message.type) {
      case "ready":
        clearTimeout(this.startupTimer)
        this.workerReady = true
        if (this.endpoint) this.announceReady()
        break
      case "fatal":
        void this.stop(new MoeJSError({ ...message.error, kind: "fatal" }, this))
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
        if (message.kind === "held") for (const id of message.ids ?? []) this.held.add(id)
        else if (message.kind === "released") this.releaseCallbacks(message.ids ?? [])
        break
      case "response": {
        const pending = this.finish(message.id)
        if (!pending) {
          this.discard(message.value)
          this.discard(message.error)
          return
        }
        if (message.ok) pending.resolve(message.value)
        else
          pending.reject(
            moeJSError(
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

  /** Each function occurrence gets its own registration, freed once Go collects its guest function. */
  encode(value: unknown): WireValue {
    this.assertUsable()
    const ids: number[] = []
    let wire: WireValue
    try {
      wire = encode(
        value,
        (fn) => {
          const id = this.nextCallbackId++
          this.callbacks.set(id, fn)
          ids.push(id)
          return id
        },
        this
      )
    } catch (error) {
      for (const id of ids) this.callbacks.delete(id)
      throw error
    }
    if (ids.length && this.stagedWires) {
      Object.defineProperty(wire, stagedIds, { value: ids })
      this.stagedWires.register(wire, ids, wire)
      this.staged++
    }
    return wire
  }

  /** Claims the callbacks a posted payload carries; deep, because a missed root would free a live one. */
  private commit(payload: unknown): void {
    if (this.staged === 0 || typeof payload !== "object" || payload === null) return
    if (isWire(payload)) {
      const ids = (payload as { [stagedIds]?: number[] })[stagedIds]
      if (ids && this.stagedWires!.unregister(payload)) {
        this.staged--
        for (const id of ids) this.callbackPosts.set(id, (this.callbackPosts.get(id) ?? 0) + 1)
      }
      return
    }
    for (const item of Array.isArray(payload) ? payload : Object.values(payload)) this.commit(item)
  }

  // The wire was dropped without being posted.
  private unstage(ids: number[]): void {
    this.staged--
    for (const id of ids) if (!this.callbackPosts.has(id)) this.callbacks.delete(id)
  }

  private releaseCallbacks(ids: readonly number[]): void {
    for (const id of ids) {
      const left = (this.callbackPosts.get(id) ?? 1) - 1
      if (left > 0) this.callbackPosts.set(id, left)
      else {
        this.callbackPosts.delete(id)
        this.callbacks.delete(id)
      }
    }
  }

  decode(value: WireValue): unknown {
    return decode(value, this)
  }

  /** Batches a handle release into one message per turn; it is never reentrant, so it stays behind earlier requests. */
  releaseHandle(kind: "value" | "native" | "script" | "module", id: number, count: number): void {
    if (this.stopped) return
    if (!this.releases) {
      this.releases = { value: [], native: [], script: [], module: [] }
      queueMicrotask(() => this.flushReleases())
    }
    if (kind === "value" || kind === "native") this.releases[kind].push(id, count)
    else this.releases[kind].push(id)
  }
  private flushReleases(): void {
    const batch = this.releases!
    this.releases = undefined
    if (this.stopped) return
    this.sendReply("release", {
      ...(batch.value.length && { releaseValues: batch.value }),
      ...(batch.native.length && { releaseNatives: batch.native }),
      ...(batch.script.length && { releaseScripts: batch.script }),
      ...(batch.module.length && { releaseModules: batch.module })
    })
  }

  /** Releases each Go-posted handle occurrence in a message that will not be decoded. */
  discard(data: unknown): void {
    if (typeof data !== "object" || data === null) return
    const wire = data as { t?: unknown; id?: unknown; v?: unknown; temporary?: unknown }
    if (
      (wire.t === "ref" || wire.t === "native") &&
      typeof wire.id === "number" &&
      wire.id > 0 &&
      wire.v === undefined &&
      !wire.temporary &&
      !(hostWire in wire)
    )
      return this.releaseHandle(wire.t === "ref" ? "value" : "native", wire.id, 1)
    for (const item of Array.isArray(data) ? data : Object.values(data)) this.discard(item)
  }

  /** Host objects keep their identity through payloads while the host holds them. */
  retainHost(value: object): number {
    let id = this.hostIds.get(value)
    if (id) return id
    if (this.hostRefs.size >= this.sweepAt) {
      for (const [key, ref] of this.hostRefs) if (!ref.deref()) this.hostRefs.delete(key)
      this.sweepAt = Math.max(64, this.hostRefs.size * 2)
    }
    id = this.nextHostId++
    this.hostIds.set(value, id)
    this.hostRefs.set(id, new WeakRef(value))
    return id
  }
  hostObject(id: number): object | undefined {
    return this.hostRefs.get(id)?.deref()
  }

  /** The upstream InterruptedError an interrupt with this reason gives. */
  interruptPayload(reason: unknown): ErrorPayload {
    const wire = reason === undefined ? undefined : this.encode(reason)
    const object = reason !== null && (typeof reason === "object" || typeof reason === "function")
    return {
      kind: "interrupted",
      name: "InterruptedError",
      code: "ERR_INTERRUPTED",
      message: interruptMessage(reason),
      ...(wire && { value: wire, reason: wire }),
      ...(reason instanceof Error && {
        cause: errorPayload(reason, "host", (value) => this.retainHost(value))
      }),
      ...(object && { reasonId: this.retainHost(reason) })
    }
  }

  /** What a host throw gives Go: guest Values as is, MoeJS errors losslessly, others as Errors. */
  hostThrowPayload(error: unknown): ErrorPayload {
    try {
      if (error instanceof MoeJSError) {
        const payload = errorPayload(error, "host", (value) => this.retainHost(value))
        if (error.value !== undefined) payload.value = this.encode(error.value)
        if (error.reason !== undefined) payload.reason = this.encode(error.reason)
        return payload
      }
      if (error instanceof Value)
        return { kind: "exception", name: "Error", message: "", value: this.encode(error) }
      return errorPayload(error, "host", (value) => this.retainHost(value))
    } catch (encodingError) {
      return errorPayload(encodingError)
    }
  }
  encodeGlobal(value: unknown): WireValue {
    return this.encode(value)
  }

  private async hostCall(message: Extract<WorkerMessage, { type: "hostCall" }>): Promise<void> {
    const callback = this.callbacks.get(message.callbackId)
    const generation = this.callbackGeneration
    this.callbackDepth++
    let payload: { callId: number; value?: WireValue; error?: ErrorPayload }
    let temporaries: Value[] = []
    try {
      // Decoding first counts the handles a call to a missing callback still carries.
      const [[thisValue, args], collected] = collectTemporaries(() => [
        message.thisValue ? this.decode(message.thisValue) : undefined,
        message.args.map((arg) => this.decode(arg))
      ])
      temporaries = collected
      if (!callback) throw failure("host", "Unknown host callback")
      let result = callback.apply(thisValue, args as unknown[])
      const then = thenOf(result)
      if (then) {
        const thenable = result
        result = await this.waitForCallback(
          () => new Promise((resolve, reject) => then.call(thenable, resolve, reject))
        )
      }
      payload = { callId: message.id, value: this.encode(result) }
    } catch (error) {
      payload = { callId: message.id, error: this.hostThrowPayload(error) }
    } finally {
      if (generation === this.callbackGeneration) this.callbackDepth--
      // Like NativeFunc arguments, call-scoped handles must not be kept.
      expireValues(temporaries)
    }
    if (!this.stopped && generation === this.callbackGeneration) this.sendReply("settle", payload)
  }

  private sendReply(op: string, payload: object): void {
    try {
      this.post(this.nextSettlementId--, op, payload)
      this.commit(payload)
    } catch (error) {
      void this.stop(fatal(error))
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
      if (!this.moduleRequest) {
        this.discard(message)
        throw failure("bridge", "No module importer is configured")
      }
      payload = {
        id: message.id,
        ...(await this.waitForCallback((signal) => this.moduleRequest!(message, signal)))
      }
      const ms = codeMs(payload)
      if (ms)
        for (const pending of this.pending.values())
          if (pending.scaled) pending.deadline?.extend(ms)
    } catch (error) {
      payload = { id: message.id, error: this.hostThrowPayload(error) }
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
      payload = { id: message.id, error: networkError(error) }
    }
    if (!this.stopped) this.sendReply("networkResult", payload)
  }

  assertUsable(): void {
    if (this.stopped) throw this.stopped
  }
  get isStopped(): boolean {
    return Boolean(this.stopped)
  }

  useTimeout(timeoutMs?: number): void {
    this.timeoutMs = timeoutMs
    if (this.isReady || this.stopped) return
    clearTimeout(this.startupTimer)
    const startup = timeoutMs ?? defaultTimeoutMs
    const remaining = Math.max(0, startup - (Date.now() - this.startedAt))
    this.startupTimer = setTimeout(() => void this.stop(new TimeoutError(startup)), remaining)
  }

  /** Runtime interrupts are recoverable; compiler endpoints remain disposable. */
  enableRecovery(): void {
    this.recoverable = true
  }
  /** Compiler endpoints: Go enforces compile timeouts, and an abort replaces only the endpoint. */
  enableRecycling(): void {
    this.recyclable = true
  }

  interrupt(reason?: unknown): void {
    this.assertUsable()
    const payload = this.interruptPayload(reason)
    // As upstream, each request settles when Go stops it; only waiting host callbacks are cancelled.
    this.cancelCallbacks(new MoeJSError(payload, this))
    this.sendReply("interrupt", { interruptError: payload })
  }

  private cancelCallbacks(error: unknown) {
    this.callbackGeneration++
    this.callbackDepth = 0
    for (const cancel of this.callbackCancellations) cancel(error)
    this.callbackCancellations.clear()
  }
  private rejectPending(error: unknown) {
    this.cancelCallbacks(error)
    for (const id of this.pending.keys()) this.finish(id)?.reject(error)
  }

  request<T>(op: string, payload: object = {}, options: RequestOptions = {}): Promise<T> {
    return this.enqueue<T>(op, payload, options, this.callbackDepth > 0)
  }

  /** Control and Promise settlement must progress while an outer call is awaiting. */
  control<T>(
    op: string,
    payload: object = {},
    options: RequestOptions = {},
    bounded = true
  ): Promise<T> {
    if (this.callbackDepth && (op === "loopRun" || op === "loopStart"))
      return Promise.reject(loopRunning())
    if (this.callbackDepth && ["loopStop", "loopTerminate", "loopNew"].includes(op))
      return Promise.reject(
        failure("host", "A runtime callback cannot wait for its own event loop to stop")
      )
    if (op === "interrupt" && !this.stopped)
      this.cancelCallbacks(
        new MoeJSError((payload as { interruptError: ErrorPayload }).interruptError, this)
      )
    return this.enqueue<T>(op, payload, options, true, bounded)
  }

  private enqueue<T>(
    op: string,
    payload: object,
    options: RequestOptions,
    immediate: boolean,
    bounded = true
  ): Promise<T> {
    if (this.stopped) return Promise.reject(this.stopped)
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    const set = bounded ? (options.timeoutMs ?? this.timeoutMs) : options.timeoutMs
    const scaled = bounded && set === undefined
    let timeoutMs: number | undefined
    try {
      timeoutMs = scaled
        ? Math.min(maxTimeoutMs, defaultTimeoutMs + codeMs(payload))
        : set === undefined
          ? undefined
          : checkTimeout(set)
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const pending: Pending = {
      resolve: (value) => resolve(value as T),
      reject,
      scaled,
      sent: false,
      signal: options.signal
    }
    const cancel = (error: unknown) => {
      if (!this.finish(id)) return
      if (!pending.sent || this.recyclable || !this.recoverable) {
        reject(error)
        if (!pending.sent) return
        void this.stop(
          this.recyclable
            ? new EndpointRecycled()
            : error instanceof MoeJSError
              ? error
              : failure("interrupted", String(error))
        )
        return
      }
      // A request's own signal or timeout interrupts the runtime, as a Context does upstream.
      const payload = this.interruptPayload(error)
      const interrupted = new MoeJSError(payload, this)
      reject(interrupted)
      this.cancelCallbacks(interrupted)
      this.sendReply("interrupt", { interruptError: payload })
    }
    if (options.signal) {
      pending.abort = () => cancel(options.signal!.reason)
      options.signal.addEventListener("abort", pending.abort, { once: true })
    }
    this.pending.set(id, pending)
    const send = () => {
      if (this.stopped || !this.pending.has(id)) return
      pending.sent = true
      // Go fails a compile at its deadline; this timer only backs up a wedged endpoint.
      const goDeadline = this.recyclable && compileOps.has(op) && timeoutMs !== undefined
      if (timeoutMs !== undefined)
        pending.deadline = deadline(
          goDeadline ? Math.min(maxTimeoutMs, timeoutMs + 1000) : timeoutMs,
          () => cancel(new TimeoutError(timeoutMs!))
        )
      this.post(id, op, {
        ...payload,
        reentrant: immediate,
        ...(goDeadline && { deadlineAt: Date.now() + timeoutMs!, deadlineMs: timeoutMs })
      })
      this.commit(payload)
    }
    const fail = (error: unknown) => {
      this.finish(id)?.reject(error)
    }
    const ahead = !immediate && this.queued > 0
    const previous = this.tail
    if (!immediate) {
      this.queued++
      const settled = () => {
        this.queued--
      }
      this.tail = promise.then(settled, settled)
    }
    if (this.isReady && !ahead) {
      try {
        send()
      } catch (error) {
        fail(error)
      }
    } else {
      void (immediate ? this.ready : previous.then(() => this.ready)).then(send).catch(fail)
    }
    return promise
  }

  stop(reason: MoeJSError = failure("closed", "MoeJS runtime is closed")): Promise<void> {
    if (this.stopped) return this.termination
    this.stopped = reason
    this.stopGate.resolve()
    clearTimeout(this.startupTimer)
    this.readyGate.reject(reason)
    this.rejectPending(reason)
    this.callbacks.clear()
    this.moduleRequest = undefined
    this.networkRequest = undefined
    return this.terminateEndpoint()
  }
}
