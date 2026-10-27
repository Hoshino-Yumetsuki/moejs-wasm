import { createMoeJS as createEngine } from "./core"
import type { Engine, EngineOptions } from "./core"
import { browserAdapter } from "./adapters/browser"

export * from "./core"
export { browserAdapter } from "./adapters/browser"

export function createMoeJS(options: EngineOptions = {}): Promise<Engine> {
  return createEngine({ ...options, adapter: options.adapter ?? browserAdapter() })
}
