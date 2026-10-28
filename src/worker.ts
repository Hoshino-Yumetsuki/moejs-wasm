import { startGoRuntime, type GoEndpoint } from "./go-runtime"
import { createGo } from "./go-shim.mjs"
import { errorPayload } from "./wire"
import type { WorkerMessage, WorkerRequest } from "./adapter"

type Incoming =
  | { type: "init"; module: WebAssembly.Module; json?: boolean }
  | WorkerRequest
  | string
let endpoint: GoEndpoint | undefined
let interruptWord: Int32Array | undefined
let initialized = false
let send: (message: WorkerMessage | string) => void
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
  if (typeof message === "string") {
    try {
      if (!endpoint) throw new Error("MoeJS worker has not initialized")
      endpoint.postJSON(message)
    } catch (error) {
      send({ type: "fatal", error: errorPayload(error, "bridge") })
    }
  } else if (message.type === "init") {
    if (initialized) return
    initialized = true
    void startGoRuntime(message.module, createGo, {
      message: (event) => send(event),
      json: message.json ? (event) => send(event) : undefined,
      error: (error) => send({ type: "fatal", error: errorPayload(error, "internal") })
    })
      .then((value) => {
        endpoint = value
        if (interruptWord) value.setInterruptWord(interruptWord)
      })
      .catch((error: unknown) => {
        send({ type: "fatal", error: errorPayload(error, "internal") })
      })
  } else if (message.type === "request" && message.op === "interruptWord") {
    const { buffer } = message.payload as { buffer?: unknown }
    if (typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer) {
      interruptWord = new Int32Array(buffer, 0, 1)
      endpoint?.setInterruptWord(interruptWord)
    }
  } else {
    try {
      if (!endpoint) throw new Error("MoeJS worker has not initialized")
      endpoint.postMessage(message)
    } catch (error) {
      send({ type: "fatal", error: errorPayload(error, "bridge") })
    }
  }
})
