import type { ErrorPayload, WireValue } from "./wire"
import type { NetworkMessage } from "./network"

export interface WorkerRequest {
  type: "request"
  id: number
  op: string
  payload: object
}

export type WorkerMessage =
  | { type: "ready" }
  | { type: "fatal"; error: ErrorPayload }
  | { type: "response"; id: number; ok: boolean; value?: unknown; error?: ErrorPayload }
  | { type: "hostCall"; id: number; callbackId: number; args: WireValue[]; thisValue?: WireValue }
  | NetworkMessage
  | {
      type: "event"
      kind: string
      ids?: number[]
      error?: ErrorPayload
      operation?: "reject" | "handle"
      promise?: WireValue
      result?: WireValue
      state?: "pending" | "fulfilled" | "rejected"
    }
  | {
      type: "moduleRequest"
      id: number
      kind: "resolve" | "meta"
      referrer?:
        | { kind: "module" | "script"; id: number }
        | { kind: "native"; id: number; native: WireValue }
      specifier?: string
      meta?: WireValue
    }

export interface WorkerEndpoint {
  postMessage(message: WorkerRequest): void
  terminate(): void | Promise<void>
}

export interface WorkerHandlers {
  message(message: WorkerMessage): void
  error(error: unknown): void
}

const compiled = new Map<string, WeakRef<WebAssembly.Module>>()
const compiling = new Map<string, Promise<WebAssembly.Module>>()
export function cachedModule(
  key: string,
  compile: () => Promise<WebAssembly.Module>
): Promise<WebAssembly.Module> {
  const cached = compiled.get(key)?.deref()
  if (cached) return Promise.resolve(cached)
  let pending = compiling.get(key)
  if (!pending) {
    pending = compile()
      .then((module) => {
        compiled.set(key, new WeakRef(module))
        return module
      })
      .finally(() => compiling.delete(key))
    compiling.set(key, pending)
  }
  return pending
}

export async function compileResponse(response: Response): Promise<WebAssembly.Module> {
  if (!response.ok)
    throw new Error(`Cannot load MoeJS WASM: ${response.status} ${response.statusText}`)
  return WebAssembly.compile(await response.arrayBuffer())
}

// Network results carry bytes and the interrupt word a SharedArrayBuffer; worker JS handles both, not Go.
export function toWorker(message: WorkerRequest): WorkerRequest | string {
  return message.op === "networkResult" || message.op === "interruptWord"
    ? message
    : JSON.stringify(message)
}
export function fromWorker(data: WorkerMessage | string): WorkerMessage {
  return typeof data === "string" ? (JSON.parse(data) as WorkerMessage) : data
}

export interface Adapter {
  loadModule(wasmURL?: string | URL): Promise<WebAssembly.Module>
  /** Start a separate runtime, emit ready when dispatch is installed. */
  createWorker(
    module: WebAssembly.Module,
    options: { workerURL?: string | URL; timeoutMs: number },
    handlers: WorkerHandlers
  ): Promise<WorkerEndpoint>
}
