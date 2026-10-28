import type { WorkerEndpoint, WorkerHandlers, WorkerMessage, WorkerRequest } from "./adapter"
import type { NetworkError, NetworkMessage, NetworkRequest } from "./network"
import { errorPayload } from "./wire"

export interface GoHandlers extends WorkerHandlers {
  json?(message: string): void
}

export interface GoEndpoint extends WorkerEndpoint {
  postJSON(request: string): void
  setInterruptWord(word: Int32Array): void
}

export interface GoRuntime {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
  exit(code: number): void
}

export type CreateGo = (scope: Record<string, unknown>) => GoRuntime

// Go's js/wasm time.Local is a fixed offset; the bridge loads this zone's rules instead.
function hostTimeZone(): string | undefined {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === "string" && zone !== "" ? zone : undefined
  } catch {
    return undefined
  }
}

/** Each Go instance gets a private syscall/js global, never the host global object. */
export async function startGoRuntime(
  module: WebAssembly.Module,
  createGo: CreateGo,
  handlers: GoHandlers
): Promise<GoEndpoint> {
  let closed = false
  let dispatch: ((request: string) => void) | undefined
  let termination: Promise<void> | undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false
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
  const networkCall = (message: Omit<NetworkMessage, "type" | "id">) => {
    const id = ++nextNetworkID
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    networkPending.set(id, { resolve, reject })
    deliver({ ...message, type: "networkRequest", id })
    return { id, promise }
  }
  const cancelNetwork = (id: number) => networkCall({ kind: "cancel", bodyId: id }).promise
  const deliver = (message: WorkerMessage) => {
    queueMicrotask(() => {
      if (!closed && !stopped) handlers.message(message)
    })
  }
  const deliverJSON = (json: string) => {
    queueMicrotask(() => {
      if (closed || stopped) return
      if (handlers.json) handlers.json(json)
      else handlers.message(JSON.parse(json) as WorkerMessage)
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
    __moeMessage: deliverJSON,
    __moeTimeZone: hostTimeZone(),
    __moeNetworkAllow(request: string) {
      const call = networkCall({ kind: "allow", request: JSON.parse(request) as NetworkRequest })
      return {
        ...guarded(call.promise),
        cancel: () => {
          networkPending.get(call.id)?.reject({ message: "Network policy canceled" })
          networkPending.delete(call.id)
          void cancelNetwork(call.id).catch(() => {})
        }
      }
    },
    // The bridge's http.RoundTripper: bytes are a request body or an upload chunk.
    __moeNetwork(kind: NetworkMessage["kind"], json: string, bytes?: Uint8Array<ArrayBuffer>) {
      const message = JSON.parse(json) as Omit<NetworkMessage, "type" | "id" | "kind">
      if (bytes) {
        if (kind === "write") message.chunk = bytes
        else message.init = { ...message.init, body: bytes }
      }
      const call = networkCall({ ...message, kind })
      void call.promise.catch(() => {})
      return {
        id: call.id,
        ...guarded(call.promise),
        cancel: () => {
          networkPending.get(call.id)?.reject({ message: "Network request canceled" })
          networkPending.delete(call.id)
          void cancelNetwork(message.bodyId ?? call.id).catch(() => {})
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
    for (const pending of networkPending.values())
      pending.reject({ message: "MoeJS Go runtime is closed" })
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
    // Go polls the word while guest code runs, so an interrupt posted meanwhile reaches it.
    let interruptWord: Int32Array | undefined
    go.importObject.moejs = {
      interruptSeq: () => (interruptWord ? Atomics.load(interruptWord, 0) : 0)
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
    const postJSON = (request: string) => {
      if (closed || stopped) throw new Error("MoeJS Go runtime is closed")
      try {
        dispatch?.(request)
      } catch (error) {
        deliver({ type: "fatal", error: errorPayload(error, "internal") })
      }
    }
    return {
      postJSON,
      setInterruptWord(word) {
        interruptWord = word
      },
      postMessage(request: WorkerRequest) {
        if (closed || stopped) throw new Error("MoeJS Go runtime is closed")
        // In the current realm the host thread is Go's, so a word could never be read early.
        if (request.op === "interruptWord") return
        if (request.op === "networkResult") {
          const result = request.payload as { id: number; value?: unknown; error?: NetworkError }
          const pending = networkPending.get(result.id)
          networkPending.delete(result.id)
          if (result.error !== undefined) pending?.reject(result.error)
          else pending?.resolve(result.value)
          return
        }
        postJSON(JSON.stringify(request))
      },
      terminate() {
        if (termination) return termination
        closed = true
        if (!stopped) dispatch?.(JSON.stringify({ id: -2147483648, op: "close", payload: {} }))
        termination = lifetime
          .catch(() => undefined)
          .finally(() => {
            dispatch = undefined
            cleanup()
            delete scope.__moeDispatch
            delete scope.__moeMessage
            delete scope.__moeFatal
            delete scope.__moeNetworkAllow
            delete scope.__moeNetwork
            delete scope.__moeTimeZone
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
