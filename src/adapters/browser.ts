import {
  cachedModule,
  compileResponse,
  fromWorker,
  toWorker,
  type Adapter,
  type WorkerMessage
} from "../adapter"

export function browserAdapter(): Adapter {
  return {
    async loadModule(wasmURL = new URL("./moejs.wasm", import.meta.url)) {
      // Key by the URL fetch resolves: relative to the document.
      const { url } = new Request(wasmURL)
      return cachedModule(url, async () => compileResponse(await fetch(url)))
    },
    async createWorker(module, options, handlers) {
      const url = options.workerURL
        ? new URL(options.workerURL, import.meta.url)
        : new URL("./worker.mjs", import.meta.url)
      const worker = new Worker(url, { type: "module" })
      worker.onmessage = (event: MessageEvent<WorkerMessage | string>) =>
        handlers.message(fromWorker(event.data))
      worker.onerror = (event) => handlers.error(new Error(event.message || "MoeJS worker failed"))
      worker.onmessageerror = () => handlers.error(new Error("Cannot decode MoeJS worker message"))
      worker.postMessage({ type: "init", module, json: true })
      return {
        postMessage: (message) => worker.postMessage(toWorker(message)),
        terminate: () => worker.terminate()
      }
    }
  }
}
