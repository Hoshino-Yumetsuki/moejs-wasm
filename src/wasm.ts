import { compileResponse, type Adapter } from "./adapter"
import { createMoeJS as createEngine } from "./core"
import type { Engine, EngineOptions } from "./core"
import { createGo } from "./go-shim.mjs"
import { startGoRuntime } from "./go-runtime"

export * from "./core"

export type WasmSource = WebAssembly.Module | BufferSource | Response | URL | string

export interface WasmOptions extends Omit<EngineOptions, "adapter" | "wasmURL" | "workerURL"> {
  wasm: WasmSource
}

/** Runs in the current JS realm, without workers or platform-specific imports. */
export function wasmAdapter(source: WasmSource): Adapter {
  return {
    async loadModule() {
      if (source instanceof WebAssembly.Module) return source
      if (source instanceof Response) return compileResponse(source)
      if (typeof source === "string" || source instanceof URL)
        return compileResponse(await fetch(source))
      return WebAssembly.compile(source)
    },
    async createWorker(module, _options, handlers) {
      return startGoRuntime(module, createGo, handlers)
    }
  }
}

export function createMoeJS(options: WasmOptions): Promise<Engine> {
  return createEngine({ ...options, adapter: wasmAdapter(options.wasm) })
}
