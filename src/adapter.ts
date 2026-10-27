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

export interface Adapter {
  loadModule(wasmURL?: string | URL): Promise<WebAssembly.Module>
  /** Start a separate runtime, emit ready when dispatch is installed. */
  createWorker(
    module: WebAssembly.Module,
    options: { workerURL?: string | URL; timeoutMs: number },
    handlers: WorkerHandlers
  ): Promise<WorkerEndpoint>
}
