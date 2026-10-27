import { startGoRuntime } from "./go-runtime"
import { createGo } from "./go-shim.mjs"
import { errorPayload } from "./wire"
import type { WorkerEndpoint, WorkerMessage, WorkerRequest } from "./adapter"

type Incoming = { type: "init"; module: WebAssembly.Module } | WorkerRequest
let endpoint: WorkerEndpoint | undefined
let initialized = false
let send: (message: WorkerMessage) => void
let listen: (callback: (message: Incoming) => void) => void

if (typeof process !== "undefined" && process.versions?.node) {
  // Node's worker ports do not exist in browser module workers.
  const { parentPort } = await import("node:worker_threads")
  if (!parentPort) throw new Error("MoeJS worker must run inside a worker thread")
  send = (message) => parentPort.postMessage(message)
  listen = (callback) => {
    parentPort.on("message", callback)
  }
} else {
  send = (message) => globalThis.postMessage(message)
  listen = (callback) => {
    globalThis.addEventListener("message", (event: MessageEvent<Incoming>) => callback(event.data))
  }
}

listen((message) => {
  if (message.type === "init") {
    if (initialized) return
    initialized = true
    void startGoRuntime(message.module, createGo, {
      message: (event) => send(event),
      error: (error) => send({ type: "fatal", error: errorPayload(error, "internal") })
    })
      .then((value) => {
        endpoint = value
      })
      .catch((error: unknown) => {
        send({ type: "fatal", error: errorPayload(error, "internal") })
      })
  } else {
    try {
      if (!endpoint) throw new Error("MoeJS worker has not initialized")
      endpoint.postMessage(message)
    } catch (error) {
      send({ type: "fatal", error: errorPayload(error, "bridge") })
    }
  }
})
