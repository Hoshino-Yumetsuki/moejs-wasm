import type { WorkerEndpoint, WorkerHandlers, WorkerMessage, WorkerRequest } from "./adapter"
import type { NetworkMessage, NetworkRequest } from "./network"
import { errorPayload } from "./wire"

export interface GoRuntime {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
  exit(code: number): void
}

export type CreateGo = (scope: Record<string, unknown>) => GoRuntime

/** Each Go instance gets a private syscall/js global, never the host global object. */
export async function startGoRuntime(
  module: WebAssembly.Module,
  createGo: CreateGo,
  handlers: WorkerHandlers
): Promise<WorkerEndpoint> {
  let closed = false
  let dispatch: ((request: string) => void) | undefined
  let termination: Promise<void> | undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false
  const HostAbortController = globalThis.AbortController
  const controllers = new Set<AbortController>()
  const readers = new Set<{ cancel(): Promise<unknown> }>()
  const networkPending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >()
  let nextNetworkID = 0
  // Go callbacks must never run after their WASM instance exits.
  const guarded = <T>(promise: Promise<T>) => ({
    then(resolve: (value: T) => void, reject: (error: unknown) => void) {
      void promise.then(
        (value) => {
          if (!stopped) resolve(value)
        },
        (error: unknown) => {
          if (!stopped) reject(error)
        }
      )
    }
  })
  function NativeAbortController() {
    const controller = new HostAbortController()
    controllers.add(controller)
    return controller
  }
  const networkCall = (message: Omit<NetworkMessage, "type" | "id">) => {
    const id = ++nextNetworkID
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    networkPending.set(id, { resolve, reject })
    deliver({ ...message, type: "networkRequest", id })
    return { id, promise }
  }
  const cancelNetwork = (id: number) => networkCall({ kind: "cancel", bodyId: id }).promise
  const nativeFetch = (input: string, init: RequestInit = {}) => {
    const headers = Array.from(new Headers(init.headers).entries())
    const body = init.body instanceof Uint8Array ? Array.from(init.body) : undefined
    const call = networkCall({
      kind: "fetch",
      request: { url: input, method: init.method ?? "GET", headers },
      init: { method: init.method, headers, body }
    })
    const abort = () => {
      networkPending.get(call.id)?.reject(new Error("Network request canceled"))
      networkPending.delete(call.id)
      void cancelNetwork(call.id).catch(() => {})
    }
    init.signal?.addEventListener("abort", abort, { once: true })
    if (init.signal?.aborted) abort()
    const finish = () => {
      init.signal?.removeEventListener("abort", abort)
      if (init.signal) {
        for (const controller of controllers) {
          if (controller.signal === init.signal) controllers.delete(controller)
        }
      }
    }
    return guarded(
      call.promise.then(
        (value) => {
          const response = value as {
            status: number
            statusText: string
            headers: [string, string][]
            url: string
            bodyId?: number
          }
          const reader = {
            read() {
              return networkCall({ kind: "read", bodyId: response.bodyId }).promise.then(
                (value) => {
                  const chunk = value as { done: boolean; value?: number[] }
                  if (chunk.done) {
                    readers.delete(reader)
                    finish()
                  }
                  return {
                    done: chunk.done,
                    value: chunk.value ? new Uint8Array(chunk.value) : undefined
                  }
                },
                (error: unknown) => {
                  readers.delete(reader)
                  finish()
                  throw error
                }
              )
            },
            cancel() {
              readers.delete(reader)
              finish()
              return response.bodyId === undefined
                ? Promise.resolve()
                : cancelNetwork(response.bodyId)
            }
          }
          if (response.bodyId !== undefined) readers.add(reader)
          else finish()
          return {
            ...response,
            headers: new Headers(response.headers),
            redirected: false,
            body:
              response.bodyId === undefined
                ? null
                : {
                    getReader() {
                      return {
                        read: () => guarded(reader.read()),
                        cancel: () => guarded(reader.cancel())
                      }
                    }
                  },
            arrayBuffer() {
              return guarded(
                (async () => {
                  const chunks: Uint8Array[] = []
                  let size = 0
                  if (response.bodyId !== undefined) {
                    for (;;) {
                      const chunk = await reader.read()
                      if (chunk.done) break
                      if (chunk.value) {
                        chunks.push(chunk.value)
                        size += chunk.value.length
                      }
                    }
                  }
                  const bytes = new Uint8Array(size)
                  let offset = 0
                  for (const chunk of chunks) {
                    bytes.set(chunk, offset)
                    offset += chunk.length
                  }
                  return bytes.buffer
                })()
              )
            }
          }
        },
        (error: unknown) => {
          finish()
          throw error
        }
      )
    )
  }
  const deliver = (message: WorkerMessage) => {
    queueMicrotask(() => {
      if (!closed && !stopped) handlers.message(message)
    })
  }
  const scope: Record<string, unknown> = {
    Object,
    Array,
    Uint8Array,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    TextEncoder,
    TextDecoder,
    Date,
    console,
    fetch: nativeFetch,
    Headers: globalThis.Headers,
    AbortController: NativeAbortController,
    setTimeout(callback: () => void, delay: number) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!stopped) callback()
      }, delay)
      timers.add(timer)
      return timer
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      timers.delete(timer)
      clearTimeout(timer)
    },
    __moeRespond(response: string) {
      const payload = JSON.parse(response) as Omit<
        Extract<WorkerMessage, { type: "response" }>,
        "type"
      >
      deliver({ ...payload, type: "response" })
    },
    __moeHostCall(event: string) {
      const payload = JSON.parse(event) as Omit<
        Extract<WorkerMessage, { type: "hostCall" }>,
        "type"
      >
      deliver({ ...payload, type: "hostCall" })
    },
    __moeModuleRequest(event: string) {
      const payload = JSON.parse(event) as Omit<
        Extract<WorkerMessage, { type: "moduleRequest" }>,
        "type"
      >
      deliver({ ...payload, type: "moduleRequest" })
    },
    __moeEvent(event: string) {
      deliver(JSON.parse(event) as WorkerMessage)
    },
    __moeNetworkAllow(request: string) {
      const call = networkCall({ kind: "allow", request: JSON.parse(request) as NetworkRequest })
      return {
        ...guarded(call.promise),
        cancel: () => {
          networkPending.get(call.id)?.reject(new Error("Network policy canceled"))
          networkPending.delete(call.id)
          void cancelNetwork(call.id).catch(() => {})
        }
      }
    },
    __moeFatal(error: string) {
      deliver({ type: "fatal", error: JSON.parse(error) })
    }
  }
  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
  const cleanup = () => {
    stopped = true
    clearTimers()
    for (const controller of controllers) controller.abort()
    controllers.clear()
    for (const reader of readers) void reader.cancel().catch(() => {})
    readers.clear()
    for (const pending of networkPending.values())
      pending.reject(new Error("MoeJS Go runtime is closed"))
    networkPending.clear()
  }
  try {
    const go = createGo(scope)
    go.exit = (code) => {
      cleanup()
      if (!closed) {
        handlers.error(new Error(`MoeJS Go runtime exited unexpectedly (${code})`))
      }
    }
    const instance = await WebAssembly.instantiate(module, go.importObject)
    const lifetime = go.run(instance)
    void lifetime.catch((error: unknown) => {
      cleanup()
      if (!closed) handlers.error(error)
    })
    if (typeof scope.__moeDispatch !== "function") {
      throw new Error("MoeJS Go bridge did not install its dispatch function")
    }
    dispatch = scope.__moeDispatch as (request: string) => void
    deliver({ type: "ready" })
    return {
      postMessage(request: WorkerRequest) {
        if (closed || stopped) throw new Error("MoeJS Go runtime is closed")
        if (request.op === "networkResult") {
          const result = request.payload as { id: number; value?: unknown; error?: string }
          const pending = networkPending.get(result.id)
          networkPending.delete(result.id)
          if (result.error !== undefined) pending?.reject(new Error(result.error))
          else pending?.resolve(result.value)
          return
        }
        try {
          dispatch?.(JSON.stringify(request))
        } catch (error) {
          deliver({ type: "fatal", error: errorPayload(error, "internal") })
        }
      },
      terminate() {
        if (termination) return termination
        closed = true
        if (!stopped) dispatch?.(JSON.stringify({ id: -2147483648, op: "close", payload: {} }))
        for (const controller of controllers) controller.abort()
        for (const reader of readers) void reader.cancel().catch(() => {})
        termination = lifetime
          .catch(() => undefined)
          .finally(() => {
            dispatch = undefined
            cleanup()
            delete scope.__moeDispatch
            delete scope.__moeRespond
            delete scope.__moeHostCall
            delete scope.__moeModuleRequest
            delete scope.__moeFatal
            delete scope.__moeEvent
            delete scope.__moeNetworkAllow
          })
        return termination
      }
    }
  } catch (error) {
    closed = true
    cleanup()
    throw error
  }
}
