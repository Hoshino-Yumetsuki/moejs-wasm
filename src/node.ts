import { createMoeJS as createEngine } from "./core"
import type { Engine, EngineOptions } from "./core"
import { nodeAdapter } from "./adapters/node"

export * from "./core"
export { nodeAdapter } from "./adapters/node"

export function createMoeJS(options: EngineOptions = {}): Promise<Engine> {
  return createEngine({ ...options, adapter: options.adapter ?? nodeAdapter() })
}
