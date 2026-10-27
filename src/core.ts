import type { Adapter } from "./adapter"
import { Transport, type RequestOptions } from "./transport"
import {
  defineHostFunction,
  errorPayload,
  failure,
  MoeJSError,
  TimeoutError,
  type HostFunction,
  type WireValue
} from "./wire"
import { Value, type DecodeOptions, type JSONOptions } from "./value"
import {
  EventLoop,
  createHostPromise,
  inspectPromise,
  setPromiseRejectionTracker,
  type EventLoopOptions,
  type PromiseRejectionEvent
} from "./event-loop"
import { RuntimeNetwork, networkWireOptions, type NetworkOptions } from "./network"
import { NativeHandle, nativeRoot, newNativeDecodeTarget, type NativeType } from "./native"

export { MoeJSError, TimeoutError, defineHostFunction } from "./wire"
export { Value } from "./value"
export { EventLoop } from "./event-loop"
export type { ErrorKind, ErrorPayload, HostFunction, HostFunctionOptions } from "./wire"
export type { DecodeOptions, JSONOptions } from "./value"
export { NativeHandle, nativeTypes } from "./native"
export type {
  NativeType,
  NativePrimitive,
  NativeField,
  NativeJSONCodec,
  NativeTextCodec
} from "./native"
export type LiveRoots = (add: (value: Value) => void) => void | Promise<void>
export type {
  EventLoopOptions,
  PromiseResult,
  PromiseRejectionEvent,
  HostPromise
} from "./event-loop"
export type { NetworkOptions, NetworkRequest } from "./network"
export type { RequestOptions } from "./transport"
export type {
  Adapter,
  WorkerEndpoint,
  WorkerHandlers,
  WorkerMessage,
  WorkerRequest
} from "./adapter"

export interface EngineOptions {
  adapter?: Adapter
  timeoutMs?: number
  wasmURL?: string | URL
  workerURL?: string | URL
}
export interface CoreOptions extends EngineOptions {
  adapter: Adapter
}
export interface CompileOptions extends RequestOptions {
  typeScript?: boolean
  maxSteps?: number
}
export interface FunctionOptions extends CompileOptions {
  async?: boolean
  generator?: boolean
}
export interface RuntimeOptions {
  memoryLimit?: number
  mutableIntrinsics?: boolean
  disableDynamicCode?: boolean
  maxDynamicSource?: number
  locale?: string
  timeZone?: string
  timeoutMs?: number
  maxSteps?: number
  importer?: Importer
  network?: NetworkOptions
  eventLoop?: EventLoopOptions
  onPromiseRejection?: (event: PromiseRejectionEvent) => void
}
export interface Stats {
  AllocatedBytes: number
  RequestAllocatedBytes: number
  LiveBytes: number
  Objects: number
  Strings: number
  Shapes: number
  MemoryLimitHits: number
  LastMemoryLimitError: { Limit: number; Allocated: number; Live: number; Stack: string } | null
  Interrupts: number
  ICEntries: number
  PendingJobs: number
  RegisterStackBytes: number
}
export interface Hook {
  readonly module: Module
  readonly path: readonly string[]
  readonly name: string
}
export interface Module {
  readonly name: string
  readonly exports: readonly string[]
  readonly requests: readonly string[]
  hook(...path: string[]): Hook
}
export interface Script {
  readonly name: string
}
export type Referrer = Module | Script | NativeHandle
export type Resolver = (
  referrer: Referrer | undefined,
  specifier: string
) => Module | Promise<Module>
export interface Importer {
  resolve?: Resolver
  meta?: (
    module: Module | NativeHandle,
    meta: Value
  ) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>
}
interface ModuleRecord {
  data: ModuleData
  resolutions: Map<string, ModuleData>
}
interface ModuleData {
  engine: Engine
  moduleId: number
  name: string
  source: string
  typeScript: boolean
  code: string
  earlyCode: string
  ownExports: readonly string[]
  requestLocations?: Record<string, { line: number; column: number }>
  graph?: Map<number, ModuleRecord>
  descriptor?: Module
}
interface ScriptData {
  engine: Engine
  scriptId: number
  name: string
  code: string
}
interface ModuleMetadata {
  name: string
  exports: string[]
  requests: string[]
  code: string
  earlyCode: string
  requestLocations: Record<string, { line: number; column: number }>
}
interface ScriptMetadata {
  name: string
  code: string
}
const modules = new WeakMap<Module, ModuleData>()
const scripts = new WeakMap<Script, ScriptData>()
const hooks = new WeakSet<Hook>()

function timeout(value = 1000) {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
    throw new RangeError("timeoutMs must be positive, finite, and at most 2147483647")
  return value
}
function compileBudget(value?: number) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
    throw new RangeError("maxSteps must be a positive safe integer")
  return value
}

export class Engine {
  private nextDescriptorId = 1
  private readonly runtimes = new Set<Runtime>()
  private readonly compilers = new Set<Transport>()
  private closed = false
  private compiler: Transport
  private readonly descriptors = new Map<number, Referrer>()
  readonly timeoutMs: number

  /** Use createMoeJS to initialize the engine before compiling. */
  constructor(
    private readonly module: WebAssembly.Module,
    private readonly options: CoreOptions
  ) {
    this.timeoutMs = timeout(options.timeoutMs)
    this.compiler = this.newCompiler()
  }
  private newCompiler() {
    const transport = new Transport(
      this.module,
      this.options.adapter,
      this.options.workerURL,
      this.timeoutMs
    )
    this.compilers.add(transport)
    return transport
  }
  private compilerEndpoint() {
    this.assertOpen()
    if (this.compiler.isStopped) this.compiler = this.newCompiler()
    return this.compiler
  }
  async initialize(): Promise<void> {
    await this.compiler.ready
  }
  private assertOpen() {
    if (this.closed) throw failure("closed", "MoeJS engine is closed")
  }

  compile(name: string, source: string, options: CompileOptions = {}): Promise<Module> {
    return this.compileModule(name, source, options)
  }
  compileWith(name: string, source: string, options: CompileOptions): Promise<Module> {
    return this.compileModule(name, source, options)
  }
  compileTS(name: string, source: string, options: CompileOptions = {}): Promise<Module> {
    return this.compileModule(name, source, { ...options, typeScript: true })
  }
  private async compileModule(
    name: string,
    source: string,
    options: CompileOptions
  ): Promise<Module> {
    this.assertOpen()
    const data: ModuleData = {
      engine: this,
      moduleId: this.nextDescriptorId++,
      name,
      source,
      typeScript: options.typeScript ?? false,
      code: "",
      earlyCode: "",
      ownExports: []
    }
    const metadata = await this.compilerEndpoint().request<ModuleMetadata>(
      "compile",
      {
        ...dataForModule(data),
        maxSteps: compileBudget(options.maxSteps)
      },
      options
    )
    data.code = metadata.code
    data.earlyCode = metadata.earlyCode
    data.requestLocations = metadata.requestLocations
    // Unlinked compiler exports are code.Module.Exports, the slots Hook treats as own.
    data.ownExports = Object.freeze([...metadata.exports])
    return this.moduleDescriptor(data, metadata.exports, metadata.requests)
  }
  private moduleDescriptor(
    data: ModuleData,
    exports: readonly string[],
    requests: readonly string[]
  ): Module {
    const descriptor: Module = Object.freeze({
      name: data.name,
      exports: Object.freeze([...exports]),
      requests: Object.freeze([...requests]),
      hook(...path: string[]): Hook {
        if (!path.length || !exports.includes(path[0]!))
          throw failure(
            "bridge",
            `Module ${data.name} does not export ${path[0] ?? "<empty path>"}`
          )
        const hook: Hook = Object.freeze({
          module: descriptor,
          path: Object.freeze([...path]),
          name: path.join(".")
        })
        hooks.add(hook)
        return hook
      }
    })
    modules.set(descriptor, data)
    data.descriptor ??= descriptor
    if (!this.descriptors.has(data.moduleId)) this.descriptors.set(data.moduleId, descriptor)
    return descriptor
  }
  async link(entry: Module, resolve: Resolver, options: RequestOptions = {}): Promise<Module> {
    this.assertOpen()
    if (options.signal?.aborted) throw options.signal.reason
    const duration = timeout(options.timeoutMs ?? this.timeoutMs)
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => controller.abort(new TimeoutError(duration)), duration)
    const { promise: cancelled, reject } = Promise.withResolvers<never>()
    const cancel = () => reject(controller.signal.reason)
    controller.signal.addEventListener("abort", cancel, { once: true })
    try {
      const graph = await Promise.race([
        this.resolveGraph(entry, resolve, new Map(), false, controller.signal),
        cancelled
      ])
      const data = { ...this.moduleData(entry), graph }
      const metadata = await Promise.race([
        this.compilerEndpoint().request<ModuleMetadata>("link", dataForModule(data), {
          ...options,
          signal: controller.signal
        }),
        cancelled
      ])
      data.code = metadata.code
      data.earlyCode = metadata.earlyCode
      return this.moduleDescriptor(data, metadata.exports, entry.requests)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", cancel)
    }
  }
  private moduleData(module: Module) {
    const data = modules.get(module)
    if (!data || data.engine !== this)
      throw failure("bridge", "Module belongs to a different MoeJS engine")
    return data
  }
  private async resolveGraph(
    entry: Module,
    resolve: Resolver | undefined,
    resolutions: Map<string, Promise<Module>>,
    useLinked = true,
    signal?: AbortSignal
  ): Promise<Map<number, ModuleRecord>> {
    const graph = new Map<number, ModuleRecord>()
    const visit = async (module: Module): Promise<void> => {
      if (signal?.aborted) throw signal.reason
      const data = this.moduleData(module)
      if (graph.has(data.moduleId)) return
      const record: ModuleRecord = { data, resolutions: new Map() }
      graph.set(data.moduleId, record)
      for (const specifier of module.requests) {
        const key = `module:${data.moduleId}:${specifier}`
        let pending = resolutions.get(key)
        if (!pending) {
          const known = useLinked
            ? data.graph?.get(data.moduleId)?.resolutions.get(specifier)
            : undefined
          pending = known
            ? Promise.resolve(this.descriptors.get(known.moduleId) as Module)
            : Promise.resolve().then(() => {
                if (!resolve)
                  throw failure("bridge", `No resolver for ${specifier} in ${data.name}`)
                return resolve(this.descriptors.get(data.moduleId), specifier)
              })
          resolutions.set(key, pending)
        }
        let dependency: Module
        let dependencyData: ModuleData
        const cancel = () => {
          if (resolutions.get(key) === pending) resolutions.delete(key)
        }
        signal?.addEventListener("abort", cancel, { once: true })
        try {
          if (signal?.aborted) throw signal.reason
          dependency = await pending
          if (signal?.aborted) throw signal.reason
          dependencyData = this.moduleData(dependency)
        } catch (error) {
          cancel()
          if (signal?.aborted) throw signal.reason
          const cause = errorPayload(error)
          const location = data.requestLocations?.[specifier]
          throw new MoeJSError({
            kind: "bridge",
            name: "ResolveError",
            message: `${data.name}:${location?.line ?? 0}:${location?.column ?? 0}: cannot resolve module ${JSON.stringify(specifier)}: ${cause.message}`,
            file: data.name,
            ...location,
            specifier,
            cause
          })
        } finally {
          signal?.removeEventListener("abort", cancel)
        }
        record.resolutions.set(specifier, dependencyData)
        const inherited = useLinked ? data.graph?.get(dependencyData.moduleId) : undefined
        if (inherited)
          await visit(
            this.moduleDescriptor(
              { ...dependencyData, graph: data.graph },
              dependency.exports,
              dependency.requests
            )
          )
        else await visit(dependency)
      }
    }
    await visit(entry)
    return graph
  }

  compileScript(name: string, source: string, options: CompileOptions = {}): Promise<Script> {
    return this.compileScriptInternal(
      name,
      { source, typeScript: options.typeScript ?? false },
      options
    )
  }
  compileScriptWith(name: string, source: string, options: CompileOptions): Promise<Script> {
    return this.compileScript(name, source, options)
  }
  compileFunction(
    name: string,
    params: string,
    body: string,
    options: FunctionOptions = {}
  ): Promise<Script> {
    return this.compileScriptInternal(
      name,
      {
        params,
        body,
        function: true,
        async: options.async ?? false,
        generator: options.generator ?? false,
        typeScript: options.typeScript ?? false
      },
      options
    )
  }
  compileFunctionTS(
    name: string,
    params: string,
    body: string,
    options: FunctionOptions = {}
  ): Promise<Script> {
    return this.compileFunction(name, params, body, { ...options, typeScript: true })
  }
  private async compileScriptInternal(
    name: string,
    input: {
      source?: string
      params?: string
      body?: string
      function?: boolean
      async?: boolean
      generator?: boolean
      typeScript: boolean
    },
    options: CompileOptions
  ): Promise<Script> {
    this.assertOpen()
    const scriptId = this.nextDescriptorId++
    const metadata = await this.compilerEndpoint().request<ScriptMetadata>(
      input.function ? "compileFunction" : "compileScript",
      {
        scriptId,
        name,
        ...input,
        maxSteps: compileBudget(options.maxSteps)
      },
      options
    )
    const data: ScriptData = { engine: this, scriptId, name: metadata.name, code: metadata.code }
    const descriptor: Script = Object.freeze({ name: metadata.name })
    scripts.set(descriptor, data)
    this.descriptors.set(scriptId, descriptor)
    return descriptor
  }

  async newRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
    this.assertOpen()
    const transport = new Transport(
      this.module,
      this.options.adapter,
      this.options.workerURL,
      timeout(options.timeoutMs ?? this.timeoutMs)
    )
    const resolutions = new Map<string, Promise<Module>>()
    transport.moduleRequest = async (message, signal) => {
      const referrer =
        message.referrer?.kind === "native"
          ? (transport.decode(message.referrer.native) as NativeHandle)
          : message.referrer
            ? this.descriptors.get(message.referrer.id)
            : undefined
      if (message.kind === "meta") {
        if (!referrer || (!(referrer instanceof NativeHandle) && !modules.has(referrer as Module)))
          throw failure("bridge", "Unknown module metadata referrer")
        if (!message.meta) throw failure("bridge", "Missing native import.meta value")
        const metadata = await options.importer?.meta?.(
          referrer as Module | NativeHandle,
          transport.decode(message.meta) as Value
        )
        signal.throwIfAborted()
        return {
          meta: Object.fromEntries(
            Object.entries(metadata ?? {}).map(([key, value]) => [key, transport.encode(value)])
          )
        }
      }
      const key = `${message.referrer?.kind ?? "none"}:${message.referrer?.id ?? 0}:${message.specifier!}`
      let pending = resolutions.get(key)
      if (!pending) {
        pending = Promise.resolve().then(() => {
          if (!options.importer?.resolve)
            throw failure("bridge", "No module resolver is configured")
          return options.importer.resolve(referrer, message.specifier!)
        })
        resolutions.set(key, pending)
      }
      const cancel = () => {
        if (resolutions.get(key) === pending) resolutions.delete(key)
      }
      signal.addEventListener("abort", cancel, { once: true })
      let module: Module
      try {
        module = await pending
        signal.throwIfAborted()
      } catch (error) {
        if (resolutions.get(key) === pending) resolutions.delete(key)
        throw error
      } finally {
        signal.removeEventListener("abort", cancel)
      }
      const data = this.moduleData(module)
      const graph = await this.resolveGraph(
        module,
        options.importer?.resolve,
        resolutions,
        true,
        signal
      )
      return { module: dataForModule({ ...data, graph }) }
    }
    const runtime = new Runtime(
      this,
      transport,
      () => this.runtimes.delete(runtime),
      resolutions,
      options
    )
    this.runtimes.add(runtime)
    try {
      const { importer, network, eventLoop, onPromiseRejection, ...runtimeOptions } = options
      await transport.request("newRuntime", {
        ...runtimeOptions,
        importer: Boolean(importer),
        importerMeta: Boolean(importer?.meta),
        network: networkWireOptions(network),
        loopOptions: {
          onError: Boolean(eventLoop?.onError),
          resetMemoryPerTask: eventLoop?.resetMemoryPerTask ?? false
        },
        trackRejections: Boolean(onPromiseRejection)
      })
      transport.enableRecovery()
      await runtime.network.initialize()
      return runtime
    } catch (error) {
      await runtime.close()
      throw error
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([
      ...[...this.compilers].map((compiler) =>
        compiler.stop(failure("closed", "MoeJS engine is closed"))
      ),
      ...[...this.runtimes].map((runtime) => runtime.close())
    ])
    this.runtimes.clear()
    this.compilers.clear()
    this.descriptors.clear()
  }
}

function dataForModule(data: ModuleData) {
  return {
    moduleId: data.moduleId,
    name: data.name,
    source: data.source,
    typeScript: data.typeScript,
    code: data.code,
    earlyCode: data.earlyCode,
    modules: data.graph
      ? [...data.graph.values()].map(({ data: item, resolutions }) => ({
          moduleId: item.moduleId,
          name: item.name,
          source: item.source,
          typeScript: item.typeScript,
          code: item.code,
          earlyCode: item.earlyCode,
          resolutions: Object.fromEntries(
            [...resolutions].map(([specifier, dependency]) => [specifier, dependency.moduleId])
          )
        }))
      : undefined
  }
}

export class Runtime {
  private loaded?: Module
  private rejectionTracker?: (event: PromiseRejectionEvent) => void
  readonly eventLoop: EventLoop
  readonly network: RuntimeNetwork

  /** Runtimes are created by engine.newRuntime(). */
  constructor(
    private readonly engine: Engine,
    private readonly transport: Transport,
    private readonly onClose: () => void,
    private readonly resolutions: Map<string, Promise<Module>>,
    options: RuntimeOptions = {}
  ) {
    this.eventLoop = new EventLoop(transport)
    this.network = new RuntimeNetwork(transport, options.network)
    this.rejectionTracker = options.onPromiseRejection
    transport.networkRequest = (message) => this.network.handle(message)
    transport.event = (message) => {
      if (message.kind === "loopError" && message.error) options.eventLoop?.onError?.(message.error)
      if (
        message.kind === "promiseRejection" &&
        message.promise &&
        message.result &&
        message.state &&
        message.operation
      )
        this.rejectionTracker?.({
          operation: message.operation,
          promise: transport.decode(message.promise) as Value,
          state: message.state,
          result: transport.decode(message.result) as Value
        })
    }
  }
  native(root: "runtime" | "realm" | "engine" | "moejs" = "runtime"): Promise<NativeHandle> {
    return nativeRoot(this.transport, root)
  }
  realm(): Promise<NativeHandle> {
    return this.native("realm")
  }
  newDecodeTarget(type: NativeType, initial?: unknown): Promise<NativeHandle> {
    return newNativeDecodeTarget(this.transport, type, initial)
  }
  async module(): Promise<Module | NativeHandle | null> {
    const current = await this.transport.control<{ moduleId: number } | null>("module")
    if (!current) return null
    if (current.moduleId === modules.get(this.loaded!)?.moduleId) return this.loaded!
    return (await this.native()).invoke<NativeHandle>("Module")
  }
  async thrownValue(error: unknown): Promise<{ value: Value; ok: boolean }> {
    const payload = error == null ? undefined : errorPayload(error)
    if (payload && error instanceof MoeJSError && error.value !== undefined)
      payload.value = this.transport.encode(error.value)
    const result = await this.transport.control<{ value: WireValue; ok: boolean }>("thrownValue", {
      error: payload
    })
    return { value: this.transport.decode(result.value) as Value, ok: result.ok }
  }
  stackTrace(exception?: MoeJSError | Value): Promise<string> {
    const value = exception instanceof Value ? exception : exception?.value
    return this.transport.control("stackTrace", {
      value: value instanceof Value ? this.transport.encode(value) : undefined
    })
  }
  async setGlobal(name: string, value: unknown): Promise<void> {
    await this.transport.request("setGlobal", { name, value: this.transport.encode(value) })
  }
  function(
    name: string,
    length: number,
    callback: HostFunction,
    options: { async?: boolean } = {}
  ) {
    return defineHostFunction(callback, { name, length, async: options.async ?? false })
  }
  async load(module: Module, options: RequestOptions = {}): Promise<void> {
    this.transport.assertUsable()
    const data = modules.get(module)
    if (!data || data.engine !== this.engine)
      throw failure("bridge", "Module belongs to a different MoeJS engine")
    if (this.loaded) throw failure("bridge", "A MoeJS runtime can load only one module")
    this.loaded = module
    for (const [id, record] of data.graph ?? [])
      for (const [specifier, dependency] of record.resolutions)
        this.resolutions.set(`module:${id}:${specifier}`, Promise.resolve(dependency.descriptor!))
    try {
      await this.transport.request("load", dataForModule(data), options)
    } catch (error) {
      if (!this.transport.isStopped) {
        const current = await this.transport.control<{ moduleId: number } | null>("module")
        if (!current) this.loaded = undefined
      }
      throw error
    }
  }
  private hookData(hook: Hook) {
    this.transport.assertUsable()
    const data = hooks.has(hook) ? modules.get(hook.module) : undefined
    if (
      !data ||
      data.engine !== this.engine ||
      modules.get(this.loaded!)?.moduleId !== data.moduleId
    )
      throw failure("bridge", "Hook must refer to a module loaded in this runtime")
    if (hook.module !== this.loaded && !data.ownExports.includes(hook.path[0]!)) return undefined
    return data
  }
  async has(hook: Hook): Promise<boolean> {
    const data = this.hookData(hook)
    if (!data) return false
    return this.transport.request("has", { moduleId: data.moduleId, path: [...hook.path] })
  }
  async call<T = unknown>(hook: Hook, ...args: unknown[]): Promise<T> {
    return this.callWith<T>(hook, args)
  }
  async callWith<T = unknown>(
    hook: Hook,
    args: readonly unknown[],
    options: RequestOptions = {}
  ): Promise<T> {
    const data = this.hookData(hook)
    if (!data)
      throw new MoeJSError({
        kind: "bridge",
        name: "errorString",
        message: "moejs: hook not found"
      })
    return this.transport.decode(
      await this.transport.request<WireValue>(
        "call",
        {
          moduleId: data.moduleId,
          path: [...hook.path],
          args: args.map((value) => this.transport.encode(value))
        },
        options
      )
    ) as T
  }
  async callValue(hook: Hook, ...args: unknown[]): Promise<Value> {
    const data = this.hookData(hook)
    if (!data)
      throw new MoeJSError({
        kind: "bridge",
        name: "errorString",
        message: "moejs: hook not found"
      })
    return this.transport.decode(
      await this.transport.request<WireValue>("call", {
        moduleId: data.moduleId,
        path: [...hook.path],
        args: args.map((value) => this.transport.encode(value)),
        raw: true
      })
    ) as Value
  }
  private scriptData(script: Script) {
    const data = scripts.get(script)
    if (!data || data.engine !== this.engine)
      throw failure("bridge", "Script belongs to a different MoeJS engine")
    return { scriptId: data.scriptId, name: data.name, code: data.code }
  }
  async runScript<T = unknown>(script: Script, options: RequestOptions = {}): Promise<T> {
    return this.transport.decode(
      await this.transport.request<WireValue>("runScript", this.scriptData(script), options)
    ) as T
  }
  async runScriptValue(script: Script, options: RequestOptions = {}): Promise<Value> {
    return this.transport.decode(
      await this.transport.request<WireValue>(
        "runScript",
        { ...this.scriptData(script), raw: true },
        options
      )
    ) as Value
  }
  async get<T = unknown>(...path: string[]): Promise<T> {
    return this.transport.decode(await this.transport.request<WireValue>("get", { path })) as T
  }
  async getValue(...path: string[]): Promise<Value> {
    return this.transport.decode(
      await this.transport.request<WireValue>("get", { path, raw: true })
    ) as Value
  }
  async export(name: string): Promise<{ value: Value; ok: boolean }> {
    const result = await this.transport.request<{ value: WireValue; ok: boolean }>("export", {
      name
    })
    return { value: this.transport.decode(result.value) as Value, ok: result.ok }
  }
  async evalScript<T = unknown>(
    name: string,
    source: string,
    options: RequestOptions = {}
  ): Promise<T> {
    return this.transport.decode(
      await this.transport.request<WireValue>("evalScript", { name, source }, options)
    ) as T
  }
  async evalScriptValue(
    name: string,
    source: string,
    options: RequestOptions = {}
  ): Promise<Value> {
    return this.transport.decode(
      await this.transport.request<WireValue>("evalScript", { name, source, raw: true }, options)
    ) as Value
  }
  async fromHost(value: unknown): Promise<Value> {
    return this.transport.decode(
      await this.transport.request<WireValue>("valueFromHost", {
        value: this.transport.encode(value)
      })
    ) as Value
  }
  async parseJSON(json: string | Uint8Array): Promise<Value> {
    if (typeof json === "string") return this.parseJSONString(json)
    const value = await (await this.native()).invoke<NativeHandle>("ParseJSON", json)
    try {
      return await value.asValue()
    } finally {
      await value.release()
    }
  }
  async parseJSONString(json: string): Promise<Value> {
    return this.transport.decode(
      await this.transport.request<WireValue>("valueParseJSON", { json })
    ) as Value
  }
  getProperty(value: Value, key: string): Promise<Value> {
    return value.get(key)
  }
  async callFunction<T = unknown>(fn: Value, thisValue: unknown, ...args: unknown[]): Promise<T> {
    return this.transport.decode(
      await this.transport.request<WireValue>("valueCall", {
        value: this.transport.encode(fn),
        thisValue: this.transport.encode(thisValue),
        args: args.map((value) => this.transport.encode(value))
      })
    ) as T
  }
  async callFunctionValue(fn: Value, thisValue: unknown, ...args: unknown[]): Promise<Value> {
    return this.transport.decode(
      await this.transport.request<WireValue>("valueCall", {
        value: this.transport.encode(fn),
        thisValue: this.transport.encode(thisValue),
        args: args.map((value) => this.transport.encode(value)),
        raw: true
      })
    ) as Value
  }
  appendJSON(value: Value, prefix = "", options: JSONOptions = {}) {
    return value.appendJSON(prefix, options)
  }
  appendJSONWith(value: Value, prefix = "", options: JSONOptions = {}) {
    return value.appendJSONWith(prefix, options)
  }
  toGo(value: Value, options: DecodeOptions = {}) {
    return value.toGo(options)
  }
  toGoWith(value: Value, options: DecodeOptions = {}) {
    return value.toGoWith(options)
  }
  unmarshal(
    value: Value,
    targetOrOptions: NativeHandle | DecodeOptions = {},
    options: DecodeOptions = {}
  ) {
    return value.unmarshal(targetOrOptions, options)
  }
  unmarshalWith(
    value: Value,
    targetOrOptions: NativeHandle | DecodeOptions = {},
    options: DecodeOptions = {}
  ) {
    return value.unmarshalWith(targetOrOptions, options)
  }
  toGoInto(
    value: Value,
    targetOrOptions: NativeHandle | DecodeOptions = {},
    options: DecodeOptions = {}
  ) {
    return value.toGoInto(targetOrOptions, options)
  }
  toGoIntoWith(
    value: Value,
    targetOrOptions: NativeHandle | DecodeOptions = {},
    options: DecodeOptions = {}
  ) {
    return value.toGoIntoWith(targetOrOptions, options)
  }
  newPromise() {
    return createHostPromise(this.transport)
  }
  promiseState(value: Value) {
    return inspectPromise(this.transport, value)
  }
  async setPromiseRejectionTracker(
    callback?: (event: PromiseRejectionEvent) => void
  ): Promise<void> {
    await setPromiseRejectionTracker(this.transport, Boolean(callback))
    this.rejectionTracker = callback
  }
  async stats(): Promise<Stats> {
    return this.transport.request<Stats>("stats")
  }
  async resetAllocation(): Promise<void> {
    await this.transport.request("resetAllocation")
  }
  async releaseCallData(): Promise<void> {
    await this.transport.request("releaseCallData")
  }
  private nativeRoots(roots: LiveRoots | readonly Value[]): HostFunction {
    return async (nativeAdd: unknown) => {
      const add = nativeAdd as NativeHandle
      try {
        let values: readonly Value[]
        if (typeof roots === "function") {
          const collected: Value[] = []
          await roots((value) => collected.push(value))
          values = collected
        } else values = roots
        for (const value of values) await add.call(value)
      } finally {
        await add.release()
      }
    }
  }
  async addLiveRoots(roots: LiveRoots | readonly Value[]): Promise<() => Promise<void>> {
    const remove = await (
      await this.native()
    ).invoke<NativeHandle>("AddLiveRoots", this.nativeRoots(roots))
    let removed = false
    return async () => {
      if (removed) return
      await remove.call()
      removed = true
      await remove.release()
    }
  }
  async rebaseAllocation(roots?: LiveRoots | readonly Value[]): Promise<void> {
    if (roots) await (await this.native()).invoke("RebaseAllocation", this.nativeRoots(roots))
    else await this.transport.request("rebaseAllocation")
  }
  interrupt(reason?: unknown): void {
    this.transport.interrupt(reason)
  }
  async clearInterrupt(): Promise<void> {
    await this.transport.control("clearInterrupt")
  }
  async close(): Promise<void> {
    try {
      await this.transport.stop()
    } finally {
      this.network.dispose()
      this.resolutions.clear()
      this.onClose()
    }
  }
}

export async function createMoeJS(options: CoreOptions): Promise<Engine> {
  timeout(options.timeoutMs)
  const module = await options.adapter.loadModule(options.wasmURL)
  const engine = new Engine(module, options)
  try {
    await engine.initialize()
    return engine
  } catch (error) {
    await engine.close()
    throw error
  }
}
