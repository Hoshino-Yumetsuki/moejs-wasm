import { defineHostFunction, type ErrorPayload, type WireValue } from "./wire"
import type { Value, ValueScope } from "./value"

export interface EventLoopOptions {
  /** Handles native callback/task failures and lets the loop continue. Interrupts are never handled. */
  onError?: (error: ErrorPayload) => void
  resetMemoryPerTask?: boolean
}

export interface ControlScope extends ValueScope {
  control<T>(op: string, payload?: object): Promise<T>
}

export interface PromiseResult {
  state: "pending" | "fulfilled" | "rejected"
  result: Value
}

export interface PromiseRejectionEvent extends PromiseResult {
  operation: "reject" | "handle"
  promise: Value
}

export interface HostPromise {
  readonly promise: Value
  /** Settlement is posted to the owning native loop; a paused loop must be started to apply it. */
  resolve(value?: unknown): Promise<void>
  reject(reason?: unknown): Promise<void>
}

export class EventLoop {
  constructor(private readonly scope: ControlScope) {}

  /** Runs until idle, stopped, or interrupted. Unlike start(), this has no implicit hold. */
  run(): Promise<void> {
    return this.scope.control("loopRun")
  }
  /** Runs in the background, waiting for work even when idle. */
  start(): Promise<void> {
    return this.scope.control("loopStart")
  }
  /** Waits for the current task; pending timers, holds, and tasks are preserved. */
  stop(): Promise<void> {
    return this.scope.control("loopStop")
  }
  stopNoWait(): Promise<void> {
    return this.scope.control("loopStopNoWait")
  }
  /** Permanently discards this loop's pending work, without closing the Runtime. */
  terminate(): Promise<void> {
    return this.scope.control("loopTerminate")
  }
  interrupt(reason?: unknown): Promise<void> {
    return this.scope.control("interrupt", { interruptReason: this.scope.encode(reason) })
  }
  /** Keeps run() alive until the returned idempotent release function is called. */
  async hold(): Promise<(task?: Value | (() => unknown)) => Promise<void>> {
    const holdId = await this.scope.control<number>("loopHold")
    let released = false
    return async (task?: Value | (() => unknown)) => {
      if (released) return
      const encoded = task === undefined ? undefined : this.encodeTask(task)
      released = true
      try {
        await this.scope.control("loopRelease", { holdId, task: encoded })
      } catch (error) {
        released = false
        throw error
      }
    }
  }
  /** Queues a callable guest Value or registered host callback on the native loop. */
  runOnLoop(task: Value | (() => unknown)): Promise<boolean> {
    return this.scope.control("loopRunOnLoop", { task: this.encodeTask(task) })
  }
  /** Queues a task whose failure follows native OnError/stop semantics. */
  post(task: Value | (() => unknown)): Promise<boolean> {
    return this.scope.control("loopPost", { task: this.encodeTask(task) })
  }
  private encodeTask(task: Value | (() => unknown)): WireValue {
    // A distinct callback keeps the synchronous task mode separate from generic async callbacks.
    return this.scope.encode(
      typeof task === "function" ? defineHostFunction(task, { async: false }) : task
    )
  }
}

export async function createHostPromise(scope: ControlScope): Promise<HostPromise> {
  const result = await scope.request<{ promiseId: number; promise: WireValue }>("newPromise")
  const promise = scope.decode(result.promise) as Value
  let settled = false
  const settle = async (op: string, value: unknown): Promise<void> => {
    if (settled) return
    const encoded = scope.encode(value)
    settled = true
    try {
      await scope.control(op, { promiseId: result.promiseId, value: encoded })
    } catch (error) {
      settled = false
      throw error
    }
  }
  return Object.freeze({
    promise,
    resolve: (value?: unknown) => settle("promiseResolve", value),
    reject: (reason?: unknown) => settle("promiseReject", reason)
  })
}

export async function inspectPromise(scope: ValueScope, value: Value): Promise<PromiseResult> {
  const result = await scope.request<{ state: PromiseResult["state"]; result: WireValue }>(
    "promiseState",
    { value: scope.encode(value) }
  )
  return { state: result.state, result: scope.decode(result.result) as Value }
}

export function setPromiseRejectionTracker(scope: ValueScope, enabled: boolean): Promise<void> {
  return scope.request("setPromiseRejectionTracker", { trackRejections: enabled })
}
