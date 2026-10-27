import { readFile } from "node:fs/promises"
import { Worker } from "node:worker_threads"
import type { Adapter, WorkerMessage } from "../adapter"

export function nodeAdapter(): Adapter {
  return {
    async loadModule(wasmURL = new URL("./moejs.wasm", import.meta.url)) {
      const url = typeof wasmURL === "string" ? new URL(wasmURL, import.meta.url) : wasmURL
      if (url.protocol === "file:") return WebAssembly.compile(await readFile(url))
      const response = await fetch(url)
      if (!response.ok)
        throw new Error(`Cannot load MoeJS WASM: ${response.status} ${response.statusText}`)
      return WebAssembly.compile(await response.arrayBuffer())
    },
    async createWorker(module, options, handlers) {
      const url = options.workerURL
        ? new URL(options.workerURL, import.meta.url)
        : new URL("./worker.mjs", import.meta.url)
      const worker = new Worker(url, {
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type"))
      })
      let stopped = false
      worker.on("message", (message: WorkerMessage) => handlers.message(message))
      worker.on("error", (error) => handlers.error(error))
      worker.on("messageerror", (error) => handlers.error(error))
      worker.on("exit", (code) => {
        if (!stopped) handlers.error(new Error(`MoeJS worker exited unexpectedly (${code})`))
      })
      worker.postMessage({ type: "init", module })
      return {
        postMessage: (message) => worker.postMessage(message),
        async terminate() {
          stopped = true
          await worker.terminate()
        }
      }
    }
  }
}
