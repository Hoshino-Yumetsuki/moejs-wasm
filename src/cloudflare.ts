import type { Adapter } from "./adapter"
import { createMoeJS as createEngine } from "./core"
import type { Engine, EngineOptions } from "./core"
import wasm from "./moejs.wasm"
import { wasmAdapter } from "./wasm"

export * from "./core"

export function cloudflareAdapter(module: WebAssembly.Module = wasm): Adapter {
  return wasmAdapter(module)
}

export function createMoeJS(options: EngineOptions = {}): Promise<Engine> {
  return createEngine({ ...options, adapter: options.adapter ?? cloudflareAdapter() })
}
