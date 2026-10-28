import type { Adapter } from "./adapter"
import {
  checkTimeout,
  defaultTimeoutMs,
  EndpointRecycled,
  Transport,
  type RequestOptions
} from "./transport"
import {
  defineHostFunction,
  errorPayload,
  failure,
  hookNotFound,
  MoeJSError,
  sentinel,
  TimeoutError,
  type ErrorPayload,
  type HostFunction,
  type WireValue
} from "./wire"
import { weakHandles } from "./handles"
import { Value, type DecodeOptions, type JSONOptions } from "./value"
import {
  EventLoop,
  createRuntimePromise,
  inspectPromise,
  rejectionTrackerWire,
  type EventLoopOptions,
  type PromiseRejectionEvent
} from "./event-loop"
import { RuntimeNetwork, networkWireOptions, type NetworkOptions } from "./network"
import { NativeHandle, nativeRoot, newNativeDecodeTarget, type NativeType } from "./native"

export { MoeJSError, MemoryLimitError, RawMessage, TimeoutError, defineHostFunction } from "./wire"
export { Value } from "./value"
export type { ObjectClass, PropertyDescriptor, ValueType } from "./value"
export { EventLoop } from "./event-loop"
export type { ErrorCode, ErrorKind, ErrorPayload, HostFunction, HostFunctionOptions } from "./wire"
export type { DecodeOptions, JSONOptions } from "./value"
export { NativeHandle, nativeTypes } from "./native"
export type {
  NativeType,
  NativePrimitive,
  NativeField,
  NativeJSONCodec,
  NativeTextCodec
} from "./native"
export type IntrinsicName =
  | "ObjectPrototype"
  | "FunctionPrototype"
  | "ArrayPrototype"
  | "StringPrototype"
  | "NumberPrototype"
  | "BooleanPrototype"
  | "ErrorPrototype"
  | "RegExpPrototype"
  | "DatePrototype"
  | "BigIntPrototype"
  | "ArrayIteratorPrototype"
  | "ObjectCtor"
  | "FunctionCtor"
  | "ArrayCtor"
  | "StringCtor"
  | "NumberCtor"
  | "BooleanCtor"
  | "RegExpCtor"
  | "DateCtor"
  | "JSON"
  | "Math"
  | "SymbolPrototype"
  | "SymbolCtor"
  | "IteratorPrototype"
  | "StringIteratorPrototype"
  | "MapPrototype"
  | "MapCtor"
  | "MapIteratorPrototype"
  | "SetPrototype"
  | "SetCtor"
  | "SetIteratorPrototype"
  | "WeakMapPrototype"
  | "WeakMapCtor"
  | "WeakSetPrototype"
  | "WeakSetCtor"
  | "WeakRefPrototype"
  | "WeakRefCtor"
  | "AggregateErrorPrototype"
  | "AggregateErrorCtor"
  | "RegExpStringIteratorPrototype"
export type LiveRoots = (add: (value: Value) => void) => void | Promise<void>
export type {
  EventLoopOptions,
  PromiseResult,
  PromiseRejectionEvent,
  HostPromise,
  LoopPromise,
  LoopTask
} from "./event-loop"
export type { CookieJar, NetworkOptions, NetworkRequest, RuntimeNetwork } from "./network"
export { ErrUseLastResponse } from "./network"
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
  /** Runtime endpoints started ahead of newRuntime (worker adapters only). Default 0. */
  warmRuntimes?: number
}
export interface CoreOptions extends EngineOptions {
  adapter: Adapter
}
export interface CompileOptions extends RequestOptions {
  typeScript?: boolean
  /** Unset scales the default with the source; 0 or a negative value means no limit. */
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
  /** BCP 47 tag of the default Intl locale; "" or a malformed tag means "en-US". */
  locale?: string
  /** Date's local zone, a name time.LoadLocation takes ("" is UTC); omitted means the host's zone. */
  timeZone?: string
  timeoutMs?: number
  /** Steps per task; unset means 1,000,000, 0 or a negative value no limit. */
  maxSteps?: number
  importer?: Importer
  network?: NetworkOptions
  /** false leaves out webapi.Install (fetch, URL, streams, ...); timers stay with the event loop. */
  webAPI?: boolean
  /** false gives a bare runtime: no timers, Web APIs or loop, as without eventloop.New. */
  eventLoop?: EventLoopOptions | false
  /** Runs synchronously in the operation that rejected or handled the promise. */
  onPromiseRejection?: (event: PromiseRejectionEvent) => unknown
  /** GOGC of this runtime's Go instance (debug.SetGCPercent); negative turns collection off. */
  gcPercent?: number
  /** GOMEMLIMIT of this runtime's Go instance in bytes (debug.SetMemoryLimit), not the guest's memoryLimit. */
  goMemoryLimit?: number
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
/** A nullish module is upstream's nil: "the host loaded no module". */
export type Resolver = (
  referrer: Referrer | undefined,
  specifier: string
) => Module | null | undefined | Promise<Module | null | undefined>
export interface Importer {
  resolve?: Resolver
  meta?: (
    module: Module | NativeHandle,
    meta: Value
  ) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>
}
interface ModuleRecord {
  // A graph keeps its descriptors, so an import() inside any of them finds its referrer.
  module: Module
  data: ModuleData
  resolutions: Map<string, ModuleData>
}
interface ModuleData {
  engine: Engine
  moduleId: number
  name: string
  typeScript: boolean
  code: string
  earlyCode: string
  links: boolean
  requestLocations?: Record<string, { line: number; column: number }>
  graph?: Map<number, ModuleRecord>
  linkId?: number
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
  links: boolean
  requestLocations: Record<string, { line: number; column: number }>
}
interface ScriptMetadata {
  name: string
  code: string
  // ScriptOrModule: its import() or import.meta needs the descriptor for the realm's life.
  referrer: boolean
}
const modules = new WeakMap<Module, ModuleData>()
const scripts = new WeakMap<Script, ScriptData>()
const hooks = new WeakSet<Hook>()

function loopWireOptions(transport: Transport, options: EventLoopOptions | false | undefined) {
  if (options === false) return { disabled: true }
  const onError = options?.onError
  return {
    onError: onError
      ? transport.encode(
          defineHostFunction((text: unknown) =>
            onError(new MoeJSError(JSON.parse(text as string) as ErrorPayload, transport))
          )
        )
      : undefined,
    resetMemoryPerTask: options?.resetMemoryPerTask ?? false
  }
}

function stepBudget(value?: number) {
  if (value !== undefined && !Number.isSafeInteger(value))
    throw new RangeError("maxSteps must be a safe integer; 0 or a negative value means no limit")
  return value
}

export class Engine {
  private nextDescriptorId = 1
  private readonly runtimes = new Set<Runtime>()
  private readonly compilers = new Set<Transport>()
  private closed = false
  private compiler: Transport
  private readonly warm: Transport[] = []
  private warmFailures = 0
  private readonly descriptors = new Map<number, WeakRef<Referrer> | Referrer>()
  private readonly referrers = new Map<number, Script>()
  private readonly runtimeTransports = new Set<Transport>()
  // A dropped descriptor's bytecode is released where Go holds it.
  private readonly collected = weakHandles
    ? new FinalizationRegistry<{ kind?: "script" | "module"; id: number }>(({ kind, id }) => {
        const entry = this.descriptors.get(id)
        if (entry instanceof WeakRef && entry.deref() === undefined) this.descriptors.delete(id)
        if (kind)
          for (const transport of kind === "script" ? this.runtimeTransports : [this.compiler])
            if (transport.held.delete(id)) transport.releaseHandle(kind, id, 0)
      })
    : undefined
  readonly timeoutMs: number

  /** Use createMoeJS to initialize the engine before compiling. */
  constructor(
    private readonly module: WebAssembly.Module,
    private readonly options: CoreOptions
  ) {
    this.timeoutMs = checkTimeout(options.timeoutMs ?? defaultTimeoutMs)
    const warm = options.warmRuntimes ?? 0
    if (!Number.isSafeInteger(warm) || warm < 0)
      throw new RangeError("warmRuntimes must be a nonnegative integer")
    this.compiler = this.newCompiler()
    void this.compiler.ready.then(
      () => this.refillWarm(),
      () => undefined
    )
  }
  private newTransport(timeoutMs = this.options.timeoutMs) {
    return new Transport(this.module, this.options.adapter, this.options.workerURL, timeoutMs)
  }
  private refillWarm() {
    while (!this.closed && this.warm.length < (this.options.warmRuntimes ?? 0)) {
      const transport = this.newTransport()
      this.warm.push(transport)
      void transport.ready.then(
        () => {
          this.warmFailures = 0
        },
        () => undefined
      )
      void transport.closed.then(() => {
        const index = this.warm.indexOf(transport)
        if (index < 0) return
        this.warm.splice(index, 1)
        // Stop replacing endpoints that keep failing, such as a bad workerURL.
        if (++this.warmFailures < 2) this.refillWarm()
      })
    }
  }
  private runtimeTransport(timeoutMs?: number) {
    let transport = this.warm.shift()
    while (transport?.isStopped) transport = this.warm.shift()
    if (!transport) return this.newTransport(timeoutMs)
    transport.useTimeout(timeoutMs)
    return transport
  }
  private newCompiler() {
    const transport = this.newTransport()
    transport.enableRecycling()
    this.compilers.add(transport)
    return transport
  }
  /** Re-issues a request whose compiler endpoint was replaced after a sibling's abort. */
  private async compilerRequest<T>(
    op: string,
    build: (held: ReadonlySet<number>) => object,
    options: RequestOptions
  ): Promise<T> {
    for (;;) {
      const compiler = this.compilerEndpoint()
      try {
        return await compiler.request<T>(op, build(compiler.held), options)
      } catch (error) {
        if (!(error instanceof EndpointRecycled)) throw error
      }
    }
  }
  private compilerEndpoint() {
    this.assertOpen()
    if (this.compiler.isStopped) {
      this.compilers.delete(this.compiler)
      this.compiler = this.newCompiler()
    }
    return this.compiler
  }
  async initialize(): Promise<void> {
    await this.compiler.ready
  }
  private assertOpen() {
    if (this.closed) throw failure("closed", "MoeJS engine is closed")
  }
  private descriptor(id: number): Referrer | undefined {
    const entry = this.descriptors.get(id)
    return entry instanceof WeakRef ? entry.deref() : entry
  }
  private track(id: number, descriptor: Referrer, kind?: "script" | "module") {
    this.descriptors.set(id, this.collected ? new WeakRef(descriptor) : descriptor)
    this.collected?.register(descriptor, { kind, id })
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
      typeScript: options.typeScript ?? false,
      code: "",
      earlyCode: "",
      links: false
    }
    const payload = { ...dataForModule(data), source, maxSteps: stepBudget(options.maxSteps) }
    const metadata = await this.compilerRequest<ModuleMetadata>("compile", () => payload, options)
    data.code = metadata.code
    data.earlyCode = metadata.earlyCode
    data.links = metadata.links
    data.requestLocations = metadata.requestLocations
    return this.moduleDescriptor(data, metadata.exports, metadata.requests)
  }
  private moduleDescriptor(
    data: ModuleData,
    exports: readonly string[],
    requests: readonly string[]
  ): Module {
    const exported = new Set(exports)
    const descriptor: Module = Object.freeze({
      name: data.name,
      exports: Object.freeze([...exports]),
      requests: Object.freeze([...requests]),
      hook(...path: string[]): Hook {
        if (!path.length || !exported.has(path[0]!)) throw hookNotFound()
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
    // Linked modules stay in the runtimes that loaded them, so only compiled bytecode is released.
    this.track(descriptorId(data), descriptor, data.linkId === undefined ? "module" : undefined)
    return descriptor
  }
  async link(entry: Module, resolve: Resolver, options: RequestOptions = {}): Promise<Module> {
    this.assertOpen()
    if (options.signal?.aborted) throw options.signal.reason
    const entryData = this.moduleData(entry)
    // Like moejs.Link, a module without imports, import() or import.meta is its own graph.
    if (!entryData.links) return entry
    const set = options.timeoutMs ?? this.options.timeoutMs
    const duration = set === undefined ? undefined : checkTimeout(set)
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", abort, { once: true })
    // Like moejs.Link, resolution has no deadline unless one is set.
    const timer =
      duration === undefined
        ? undefined
        : setTimeout(() => controller.abort(new TimeoutError(duration)), duration)
    const { promise: cancelled, reject } = Promise.withResolvers<never>()
    const cancel = () => reject(controller.signal.reason)
    controller.signal.addEventListener("abort", cancel, { once: true })
    try {
      const graph = await Promise.race([
        this.resolveGraph(entry, resolve, new Map(), controller.signal),
        cancelled
      ])
      const data: ModuleData = { ...entryData, graph, linkId: this.nextDescriptorId++ }
      const metadata = await Promise.race([
        this.compilerRequest<ModuleMetadata>("link", (held) => dataForModule(data, held), {
          ...options,
          signal: controller.signal
        }),
        cancelled
      ])
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
  /** Resolves each (module, specifier) once; the referrer is the module the resolver returned. */
  private async resolveGraph(
    entry: Module,
    resolve: Resolver | undefined,
    resolutions: Map<string, Promise<Module | null | undefined>>,
    signal?: AbortSignal
  ): Promise<Map<number, ModuleRecord>> {
    const graph = new Map<number, ModuleRecord>()
    const visit = async (module: Module): Promise<void> => {
      if (signal?.aborted) throw signal.reason
      const data = this.moduleData(module)
      if (graph.has(data.moduleId)) return
      const record: ModuleRecord = { module, data, resolutions: new Map() }
      graph.set(data.moduleId, record)
      for (const specifier of module.requests) {
        const key = `${data.moduleId}:${specifier}`
        let pending = resolutions.get(key)
        if (!pending) {
          pending = Promise.resolve().then(() => {
            if (!resolve)
              throw sentinel(
                "ERR_NO_RESOLVER",
                "no resolver: the host must resolve the module's requests"
              )
            return resolve(module, specifier)
          })
          resolutions.set(key, pending)
        }
        let dependency: Module
        let dependencyData: ModuleData
        // An abandoned resolution must not be reused by a later request.
        const evict = () => {
          if (resolutions.get(key) === pending) resolutions.delete(key)
        }
        signal?.addEventListener("abort", evict, { once: true })
        try {
          if (signal?.aborted) throw signal.reason
          const resolved = await pending
          if (signal?.aborted) throw signal.reason
          if (resolved == null) throw failure("bridge", "the resolver returned no module template")
          dependency = resolved
          dependencyData = this.moduleData(dependency)
        } catch (error) {
          evict()
          if (signal?.aborted) throw signal.reason
          const cause = errorPayload(error)
          const location = data.requestLocations?.[specifier]
          throw new MoeJSError({
            kind: "bridge",
            name: "ResolveError",
            code: "ERR_MODULE_RESOLVE",
            message: `${data.name}:${location?.line ?? 0}:${location?.column ?? 0}: cannot resolve module ${JSON.stringify(specifier)}: ${cause.message}`,
            file: data.name,
            ...location,
            specifier,
            cause
          })
        } finally {
          signal?.removeEventListener("abort", evict)
        }
        record.resolutions.set(specifier, dependencyData)
        if (!graph.has(dependencyData.moduleId)) await visit(dependency)
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
    const payload = { scriptId, name, ...input, maxSteps: stepBudget(options.maxSteps) }
    const metadata = await this.compilerRequest<ScriptMetadata>(
      input.function ? "compileFunction" : "compileScript",
      () => payload,
      options
    )
    const data: ScriptData = { engine: this, scriptId, name: metadata.name, code: metadata.code }
    const descriptor: Script = Object.freeze({ name: metadata.name })
    scripts.set(descriptor, data)
    if (metadata.referrer) this.referrers.set(scriptId, descriptor)
    this.track(scriptId, descriptor, metadata.referrer ? undefined : "script")
    return descriptor
  }

  async newRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
    this.assertOpen()
    const maxSteps = stepBudget(options.maxSteps)
    const { gcPercent, goMemoryLimit } = options
    if (gcPercent !== undefined && !Number.isSafeInteger(gcPercent))
      throw new RangeError("gcPercent must be a safe integer")
    if (goMemoryLimit !== undefined && !(Number.isSafeInteger(goMemoryLimit) && goMemoryLimit > 0))
      throw new RangeError("goMemoryLimit must be a positive safe integer")
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs
    const transport = this.runtimeTransport(
      timeoutMs === undefined ? undefined : checkTimeout(timeoutMs)
    )
    // Static resolutions of import()ed graphs, once per runtime as Importer.link caches them.
    const resolutions = new Map<string, Promise<Module | null | undefined>>()
    // Like the realm's module map, the runtime keeps each module import() loaded as a referrer.
    const imported = new Set<Module>()
    transport.moduleRequest = async (message, signal) => {
      const referrer =
        message.referrer?.kind === "native"
          ? (transport.decode(message.referrer.native) as NativeHandle)
          : message.referrer
            ? this.descriptor(message.referrer.id)
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
      // Like Importer.Resolve, every import() asks the host.
      if (!options.importer?.resolve) throw failure("bridge", "No module resolver is configured")
      const module = await options.importer.resolve(referrer, message.specifier!)
      signal.throwIfAborted()
      if (module == null) return { module: null }
      const data = this.moduleData(module)
      imported.add(module)
      // Static imports are resolved here in one round trip, not in the link job (a documented deviation).
      const graph =
        data.graph ??
        (module.requests.length
          ? await this.resolveGraph(module, options.importer.resolve, resolutions, signal)
          : undefined)
      return { module: dataForModule({ ...data, graph }, transport.held) }
    }
    const runtime = new Runtime(
      this,
      transport,
      () => {
        this.runtimes.delete(runtime)
        this.runtimeTransports.delete(transport)
      },
      resolutions,
      options
    )
    this.runtimes.add(runtime)
    this.runtimeTransports.add(transport)
    try {
      const { importer, network, eventLoop, onPromiseRejection, ...runtimeOptions } = options
      await transport.request("newRuntime", {
        ...runtimeOptions,
        maxSteps,
        importer: Boolean(importer),
        importerResolve: Boolean(importer?.resolve),
        importerMeta: Boolean(importer?.meta),
        network: networkWireOptions(network),
        loopOptions: loopWireOptions(transport, eventLoop),
        rejectionTracker: rejectionTrackerWire(transport, onPromiseRejection)
      })
      transport.enableRecovery()
      await runtime.network.initialize()
      return runtime
    } catch (error) {
      await runtime.close()
      throw error
    } finally {
      this.refillWarm()
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([
      ...[...this.compilers, ...this.warm.splice(0)].map((transport) =>
        transport.stop(failure("closed", "MoeJS engine is closed"))
      ),
      ...[...this.runtimes].map((runtime) => runtime.close())
    ])
    this.runtimes.clear()
    this.compilers.clear()
    this.descriptors.clear()
    this.referrers.clear()
    this.runtimeTransports.clear()
  }
}

function moduleBytecode(data: ModuleData, held: boolean) {
  return held ? { held: true } : { code: data.code, earlyCode: data.earlyCode }
}
function descriptorId(data: ModuleData) {
  return data.linkId ?? data.moduleId
}
function dataForModule(data: ModuleData, held?: ReadonlySet<number>) {
  return {
    moduleId: data.moduleId,
    linkId: data.linkId,
    name: data.name,
    typeScript: data.typeScript,
    ...moduleBytecode(data, held?.has(data.moduleId) ?? false),
    modules: data.graph
      ? [...data.graph.values()].map(({ data: item, resolutions }) => ({
          moduleId: item.moduleId,
          name: item.name,
          typeScript: item.typeScript,
          ...moduleBytecode(
            item,
            item.moduleId === data.moduleId || (held?.has(item.moduleId) ?? false)
          ),
          resolutions: Object.fromEntries(
            [...resolutions].map(([specifier, dependency]) => [specifier, dependency.moduleId])
          )
        }))
      : undefined
  }
}

export class Runtime {
  private loaded?: Module
  readonly eventLoop: EventLoop
  readonly network: RuntimeNetwork

  /** Runtimes are created by engine.newRuntime(). */
  constructor(
    private readonly engine: Engine,
    private readonly transport: Transport,
    private readonly onClose: () => void,
    private readonly resolutions: Map<string, unknown>,
    private readonly options: RuntimeOptions = {}
  ) {
    this.eventLoop = new EventLoop(transport, this)
    this.network = new RuntimeNetwork(transport, options.network)
    transport.networkRequest = (message) => this.network.handle(message)
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
    const loaded = this.loaded && modules.get(this.loaded)
    if (loaded && current.moduleId === descriptorId(loaded)) return this.loaded!
    return (await this.native()).invoke<NativeHandle>("Module")
  }
  async thrownValue(error: unknown): Promise<{ value: Value; ok: boolean }> {
    const payload = error == null ? undefined : this.transport.hostThrowPayload(error)
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
  /** Runtime.Function: like a NativeFunc, the callback gets live Value arguments valid during the call. */
  function(
    name: string,
    length: number,
    callback: HostFunction,
    options: { async?: boolean } = {}
  ) {
    return defineHostFunction(callback, { name, length, async: options.async ?? false, raw: true })
  }
  async load(module: Module, options: RequestOptions = {}): Promise<void> {
    this.transport.assertUsable()
    const data = modules.get(module)
    if (!data || data.engine !== this.engine)
      throw failure("bridge", "Module belongs to a different MoeJS engine")
    try {
      await this.transport.request("load", dataForModule(data, this.transport.held), options)
      this.loaded = module
    } catch (error) {
      // ErrModulePending leaves the module loaded and evaluating, as Runtime.Load does.
      if (this.loaded === undefined && !this.transport.isStopped) {
        if (error instanceof MoeJSError && error.code === "ERR_MODULE_PENDING") this.loaded = module
        else {
          const current = await this.transport.control<{ moduleId: number } | null>("module")
          if (current?.moduleId === descriptorId(data)) this.loaded = module
        }
      }
      throw error
    }
  }
  /** Go rebuilds the Hook from its own module; upstream lookup decides what it names. */
  private hookPayload(hook: Hook) {
    this.transport.assertUsable()
    const data = hooks.has(hook) ? modules.get(hook.module) : undefined
    if (!data || data.engine !== this.engine)
      throw failure("bridge", "Hook belongs to a different MoeJS engine")
    return { moduleId: data.moduleId, linkId: data.linkId, path: [...hook.path] }
  }
  async has(hook: Hook): Promise<boolean> {
    return this.transport.request("has", this.hookPayload(hook))
  }
  async call<T = unknown>(hook: Hook, ...args: unknown[]): Promise<T> {
    return this.callWith<T>(hook, args)
  }
  async callWith<T = unknown>(
    hook: Hook,
    args: readonly unknown[],
    options: RequestOptions = {}
  ): Promise<T> {
    const payload = this.hookPayload(hook)
    return this.transport.decode(
      await this.transport.request<WireValue>(
        "call",
        { ...payload, args: args.map((value) => this.transport.encode(value)) },
        options
      )
    ) as T
  }
  async callValue(hook: Hook, ...args: unknown[]): Promise<Value> {
    const payload = this.hookPayload(hook)
    return this.transport.decode(
      await this.transport.request<WireValue>("call", {
        ...payload,
        args: args.map((value) => this.transport.encode(value)),
        raw: true
      })
    ) as Value
  }
  private async runScriptWire(script: Script, raw: boolean, options: RequestOptions) {
    const data = scripts.get(script)
    if (!data || data.engine !== this.engine)
      throw failure("bridge", "Script belongs to a different MoeJS engine")
    const result = await this.transport.request<WireValue>(
      "runScript",
      {
        scriptId: data.scriptId,
        name: data.name,
        ...(this.transport.held.has(data.scriptId) ? { held: true } : { code: data.code }),
        raw
      },
      options
    )
    return this.transport.decode(result)
  }
  async runScript<T = unknown>(script: Script, options: RequestOptions = {}): Promise<T> {
    return (await this.runScriptWire(script, false, options)) as T
  }
  async runScriptValue(script: Script, options: RequestOptions = {}): Promise<Value> {
    return (await this.runScriptWire(script, true, options)) as Value
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
  getProperty(
    value: Value,
    key: PropertyKey,
    options: { receiver?: unknown } = {}
  ): Promise<Value> {
    return value.get(key, options)
  }
  private async valueOp<T>(op: "valueOp" | "valuePure", method: string, payload: object = {}) {
    return this.transport.request<T>(op, { method, ...payload })
  }
  private async valueResult<T>(op: "valueOp" | "valuePure", method: string, payload: object = {}) {
    const wire = await this.valueOp<WireValue | null>(op, method, payload)
    return (wire === null ? wire : this.transport.decode(wire)) as T
  }
  private operands(...values: unknown[]) {
    return { args: values.map((value) => this.transport.encode(value)) }
  }
  construct(fn: Value, args: readonly unknown[] = [], newTarget?: Value): Promise<Value> {
    return fn.construct(args, newTarget)
  }
  newObject(): Promise<Value> {
    return this.valueResult("valuePure", "NewObject")
  }
  newObjectWithProto(proto: Value | null): Promise<Value> {
    return this.valueResult("valuePure", "NewObjectWithProto", this.operands(proto))
  }
  newArray(...items: unknown[]): Promise<Value> {
    return this.valueResult("valueOp", "NewArray", this.operands(...items))
  }
  newArrayLen(length: number): Promise<Value> {
    return this.valueResult("valuePure", "NewArrayLen", this.operands(length))
  }
  newRegExp(pattern: string, flags = ""): Promise<Value> {
    return this.valueResult("valueOp", "NewRegExp", this.operands(pattern, flags))
  }
  /** NewArrayBuffer over a copy of the bytes: they cannot be shared across the boundary. */
  newArrayBuffer(data: ArrayBuffer | ArrayBufferView): Promise<Value> {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
      : new Uint8Array(data).slice()
    return this.fromHost(bytes.buffer)
  }
  async detachArrayBuffer(buffer: Value): Promise<void> {
    await this.valueOp("valuePure", "DetachArrayBuffer", this.operands(buffer))
  }
  sameValue(a: unknown, b: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "SameValue", this.operands(a, b))
  }
  sameValueZero(a: unknown, b: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "SameValueZero", this.operands(a, b))
  }
  strictEquals(a: unknown, b: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "StrictEquals", this.operands(a, b))
  }
  looseEquals(a: unknown, b: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "LooseEquals", this.operands(a, b))
  }
  /** Realm.IsLessThan: undefined when either side is NaN. */
  async isLessThan(x: unknown, y: unknown, leftFirst = true): Promise<boolean | undefined> {
    return (
      (await this.valueOp<boolean | null>(
        "valueOp",
        "IsLessThan",
        this.operands(x, y, leftFirst)
      )) ?? undefined
    )
  }
  lessThan(x: unknown, y: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "LessThan", this.operands(x, y))
  }
  greaterThan(x: unknown, y: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "GreaterThan", this.operands(x, y))
  }
  lessThanOrEqual(x: unknown, y: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "LessThanOrEqual", this.operands(x, y))
  }
  greaterThanOrEqual(x: unknown, y: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "GreaterThanOrEqual", this.operands(x, y))
  }
  add(a: unknown, b: unknown): Promise<unknown> {
    return this.valueResult("valueOp", "Add", this.operands(a, b))
  }
  instanceOf(value: unknown, target: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "InstanceOf", this.operands(value, target))
  }
  ordinaryHasInstance(c: unknown, o: unknown): Promise<boolean> {
    return this.valueOp("valueOp", "OrdinaryHasInstance", this.operands(c, o))
  }
  async stringToBigInt(text: string): Promise<bigint | undefined> {
    return (
      (await this.valueResult<bigint | null>("valuePure", "StringToBigInt", this.operands(text))) ??
      undefined
    )
  }
  global(): Promise<Value> {
    return this.valueResult("valuePure", "Global")
  }
  /** A Realm intrinsic field; null for a lazy one not built yet. */
  intrinsic(name: IntrinsicName): Promise<Value | null> {
    return this.valueResult("valuePure", "Intrinsic", { name })
  }
  /** Runtime.FromGo: lazy containers with sorted keys, as a Go host's map would convert. */
  fromGo(value: unknown): Promise<Value> {
    return this.valueResult("valueOp", "FromGo", { value: this.transport.encode(value) })
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
  /** Runtime.NewPromise: settles at once and does not hold the loop; see eventLoop.newPromise(). */
  newPromise() {
    return createRuntimePromise(this.transport)
  }
  /** webapi.Install for a runtime created with webAPI: false, once, with its network options. */
  async installWebAPI(): Promise<void> {
    await this.transport.request("installWebAPI", {
      network: networkWireOptions(this.options.network)
    })
  }
  /** eventloop.New after the previous loop was terminated, or on a bare runtime; it is not started. */
  async newEventLoop(options: EventLoopOptions = {}): Promise<void> {
    await this.transport.control("loopNew", {
      loopOptions: loopWireOptions(this.transport, options)
    })
  }
  promiseState(value: unknown) {
    return inspectPromise(this.transport, value)
  }
  async setPromiseRejectionTracker(
    callback?: (event: PromiseRejectionEvent) => unknown
  ): Promise<void> {
    await this.transport.request("setPromiseRejectionTracker", {
      rejectionTracker: rejectionTrackerWire(this.transport, callback)
    })
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
  /** Realm.MeasureLive: measures with or without a memory limit and changes no counter. */
  async measureLive(roots?: LiveRoots | readonly Value[]): Promise<number> {
    return (await this.native("realm")).invoke<number>(
      "MeasureLive",
      roots ? this.nativeRoots(roots) : null
    )
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
  checkTimeout(options.timeoutMs ?? defaultTimeoutMs)
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
