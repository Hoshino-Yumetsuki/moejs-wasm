import { defineHostFunction, type ErrorPayload, type MoeJSError, type WireValue } from "./wire"
import { Value, type ValueScope } from "./value"
import type { RequestOptions } from "./transport"
import type { Runtime } from "./core"

export interface EventLoopOptions {
  /** Runs synchronously on the loop, before the next callback. */
  onError?: (error: MoeJSError) => unknown
  resetMemoryPerTask?: boolean
}

export interface ControlScope extends ValueScope {
  control<T>(op: string, payload?: object, options?: RequestOptions, bounded?: boolean): Promise<T>
  interruptPayload(reason: unknown): ErrorPayload
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
  /** Runtime.NewPromise: settles at once and runs the jobs it queues. */
  resolve(value?: unknown): Promise<void>
  reject(reason?: unknown): Promise<void>
}

export interface LoopPromise extends HostPromise {
  /** Loop.NewPromise's settle: fn runs on the loop, its result fulfills and its throw rejects. */
  settle(fn?: LoopTask): Promise<void>
}

export type LoopTask = Value | ((rt: Runtime) => unknown)

export class EventLoop {
  constructor(
    private readonly scope: ControlScope,
    private readonly runtime: Runtime
  ) {}

  /** Loop.Run: calls fn first, then runs until idle; no deadline unless one is set. */
  run(fn?: LoopTask | RequestOptions, options: RequestOptions = {}): Promise<void> {
    const task = typeof fn === "function" || fn instanceof Value ? fn : undefined
    if (!task && fn) options = fn as RequestOptions
    return this.scope.control(
      "loopRun",
      task ? { task: this.encodeTask(task) } : {},
      options,
      false
    )
  }
  /** Runs in the background, waiting for work even when idle; the first start takes over newRuntime's. */
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
    return this.scope.control("interrupt", { interruptError: this.scope.interruptPayload(reason) })
  }
  /** Keeps run() alive until the returned idempotent release function is called. */
  async hold(): Promise<(task?: LoopTask) => Promise<void>> {
    const holdId = await this.scope.control<number>("loopHold")
    let released = false
    return async (task?: LoopTask) => {
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
  /** With no task, reports whether the loop is alive without queuing work. */
  runOnLoop(task?: LoopTask): Promise<boolean> {
    return this.scope.control(
      "loopRunOnLoop",
      task === undefined ? {} : { task: this.encodeTask(task) }
    )
  }
  /** Queues a task that can fail: its error goes to onError or stops the loop. */
  post(task?: LoopTask): Promise<boolean> {
    return this.scope.control("loopPost", task === undefined ? {} : { task: this.encodeTask(task) })
  }
  /** Loop.NewPromise: holds the loop until settled, and settles on it. */
  async newPromise(): Promise<LoopPromise> {
    const result = await this.scope.request<{ promiseId: number; promise: WireValue }>("newPromise")
    const promiseId = result.promiseId
    let settled = false
    const settle = async (op: string, payload: object): Promise<void> => {
      if (settled) return
      settled = true
      try {
        await this.scope.control(op, { promiseId, ...payload })
      } catch (error) {
        settled = false
        throw error
      }
    }
    return Object.freeze({
      promise: this.scope.decode(result.promise) as Value,
      resolve: (value?: unknown) => settle("promiseResolve", { value: this.scope.encode(value) }),
      reject: (reason?: unknown) => settle("promiseReject", { value: this.scope.encode(reason) }),
      settle: (fn?: LoopTask) =>
        settle("promiseSettle", { task: fn === undefined ? undefined : this.encodeTask(fn) })
    })
  }
  private encodeTask(task: LoopTask): WireValue {
    // A distinct callback keeps the synchronous task mode separate from generic async callbacks.
    return this.scope.encode(
      typeof task === "function"
        ? defineHostFunction(() => task(this.runtime), { async: false })
        : task
    )
  }
}

export async function createRuntimePromise(scope: ControlScope): Promise<HostPromise> {
  const result = await scope.request<{ promiseId: number; promise: WireValue }>("runtimeNewPromise")
  let settled = false
  // The first call decides, even when the jobs it ran then failed.
  const settle = async (op: string, value: unknown): Promise<void> => {
    if (settled) return
    const encoded = scope.encode(value)
    settled = true
    await scope.control(op, { promiseId: result.promiseId, value: encoded })
  }
  return Object.freeze({
    promise: scope.decode(result.promise) as Value,
    resolve: (value?: unknown) => settle("runtimePromiseResolve", value),
    reject: (reason?: unknown) => settle("runtimePromiseReject", reason)
  })
}

export async function inspectPromise(
  scope: ControlScope,
  value: unknown
): Promise<PromiseResult & { ok: boolean }> {
  const result = await scope.control<{
    state: PromiseResult["state"]
    result: WireValue
    ok: boolean
  }>("promiseState", { value: scope.encode(value) })
  return { state: result.state, result: scope.decode(result.result) as Value, ok: result.ok }
}

export function rejectionTrackerWire(
  scope: ValueScope,
  callback?: (event: PromiseRejectionEvent) => unknown
): WireValue | undefined {
  return callback
    ? scope.encode(
        defineHostFunction((promise, operation, state, result) =>
          callback({ operation, promise, state, result } as PromiseRejectionEvent)
        )
      )
    : undefined
}
