import { readFile, stat } from "node:fs/promises"
import { Worker } from "node:worker_threads"
import {
  cachedModule,
  compileResponse,
  fromWorker,
  toWorker,
  type Adapter,
  type WorkerMessage
} from "../adapter"

export function nodeAdapter(): Adapter {
  return {
    async loadModule(wasmURL = new URL("./moejs.wasm", import.meta.url)) {
      const url = typeof wasmURL === "string" ? new URL(wasmURL, import.meta.url) : wasmURL
      if (url.protocol === "file:") {
        // A rebuilt file is a different module.
        const { mtimeMs, size } = await stat(url)
        return cachedModule(`${url.href}#${mtimeMs}:${size}`, async () =>
          WebAssembly.compile(await readFile(url))
        )
      }
      return cachedModule(url.href, async () => compileResponse(await fetch(url)))
    },
    async createWorker(module, options, handlers) {
      const url = options.workerURL
        ? new URL(options.workerURL, import.meta.url)
        : new URL("./worker.mjs", import.meta.url)
      const worker = new Worker(url, {
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type"))
      })
      let stopped = false
      worker.on("message", (message: WorkerMessage | string) =>
        handlers.message(fromWorker(message))
      )
      worker.on("error", (error) => handlers.error(error))
      worker.on("messageerror", (error) => handlers.error(error))
      worker.on("exit", (code) => {
        if (!stopped) handlers.error(new Error(`MoeJS worker exited unexpectedly (${code})`))
      })
      worker.postMessage({ type: "init", module, json: true })
      return {
        postMessage: (message) => worker.postMessage(toWorker(message)),
        async terminate() {
          stopped = true
          await worker.terminate()
        }
      }
    }
  }
}
