import type { Adapter, WorkerMessage } from "../adapter"

export function browserAdapter(): Adapter {
  return {
    async loadModule(wasmURL = new URL("./moejs.wasm", import.meta.url)) {
      const response = await fetch(wasmURL)
      if (!response.ok)
        throw new Error(`Cannot load MoeJS WASM: ${response.status} ${response.statusText}`)
      return WebAssembly.compile(await response.arrayBuffer())
    },
    async createWorker(module, options, handlers) {
      const url = options.workerURL
        ? new URL(options.workerURL, import.meta.url)
        : new URL("./worker.mjs", import.meta.url)
      const worker = new Worker(url, { type: "module" })
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => handlers.message(event.data)
      worker.onerror = (event) => handlers.error(new Error(event.message || "MoeJS worker failed"))
      worker.onmessageerror = () => handlers.error(new Error("Cannot decode MoeJS worker message"))
      worker.postMessage({ type: "init", module })
      return {
        postMessage: (message) => worker.postMessage(message),
        terminate: () => worker.terminate()
      }
    }
  }
}
