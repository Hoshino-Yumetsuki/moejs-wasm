import type { ValueScope } from "./value"
import type { WireValue } from "./wire"

/** Marks a wire the host built from a handle: it decodes to that handle and keeps it alive until posted. */
export const hostWire = Symbol("moejs.hostWire")
export const weakHandles =
  typeof WeakRef === "function" && typeof FinalizationRegistry === "function"
export interface HandleState {
  scope: ValueScope
  id: number
  // Go-posted occurrences decoded into this handle, released together.
  count: number
  released: boolean
  temporary?: boolean
  inline?: WireValue
}
/** A per-scope handle cache that lets dropped handles go and releases them once collected. */
export class HandleCache<T extends object> {
  private readonly caches = new WeakMap<ValueScope, Map<number, WeakRef<T> | T>>()
  private readonly finalizer?: FinalizationRegistry<HandleState>
  constructor(private readonly kind: "value" | "native") {
    if (weakHandles)
      this.finalizer = new FinalizationRegistry((state) => {
        const cache = this.caches.get(state.scope)
        const entry = cache?.get(state.id)
        if (entry instanceof WeakRef && entry.deref() === undefined) cache!.delete(state.id)
        if (!state.released) state.scope.releaseHandle?.(this.kind, state.id, state.count)
      })
  }
  get(scope: ValueScope, id: number): T | undefined {
    const entry = this.caches.get(scope)?.get(id)
    return entry instanceof WeakRef ? entry.deref() : entry
  }
  add(scope: ValueScope, id: number, handle: T, state: HandleState): void {
    let cache = this.caches.get(scope)
    if (!cache) this.caches.set(scope, (cache = new Map()))
    cache.set(id, this.finalizer ? new WeakRef(handle) : handle)
    this.finalizer?.register(handle, state, state)
  }
  /** Forgets an explicitly released handle, so a later occurrence gets a fresh one. */
  remove(handle: T, state: HandleState): void {
    if (this.get(state.scope, state.id) === handle) this.caches.get(state.scope)!.delete(state.id)
    this.finalizer?.unregister(state)
  }
}
