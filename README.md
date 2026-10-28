# moejs-wasm

将 [MoeJS](https://github.com/MoeForge/moejs) 编译为 WebAssembly，在 JavaScript 中运行隔离的 JS 和使用可擦除类型的 TypeScript 插件。支持 Node.js、浏览器和 Cloudflare Workers。

## 构建

需要 Go 1.25+、Node.js 22+、Corepack 和 Yarn 4。无需 C 工具链或 Emscripten。

```sh
git submodule update --init --recursive
corepack enable
yarn install --immutable
yarn build
yarn test
yarn lint
yarn format:check
node examples/node.mjs
```

`external/moejs` 是 Git submodule。构建产物位于 `lib/`，发布包已包含这些产物，使用时无需安装 Go。

请使用 `yarn build` 构建。该命令通过临时 Go overlay 和生成的注册表接入完整功能。

## Node.js

```ts
import { createMoeJS } from "moejs-wasm"

const engine = await createMoeJS({ timeoutMs: 5000 })
try {
  const mod = await engine.compile(
    "plugin.js",
    `
    export async function buildRequest(task) {
      return {
        method: "POST",
        token: await utils.env("API_KEY"),
        prompt: task.prompt.trim()
      }
    }
  `
  )
  const build = mod.hook("buildRequest")
  const rt = await engine.newRuntime({
    memoryLimit: 8 * 1024 * 1024,
    maxSteps: 1_000_000
  })
  await rt.setGlobal("utils", { env: (name) => (name === "API_KEY" ? "test-key" : undefined) })
  await rt.load(mod)
  const result = await rt.call(build, { prompt: " cat " })
  console.log(result)
} finally {
  await engine.close()
}
```

CommonJS 使用 `const { createMoeJS } = require("moejs-wasm")`，其余调用一致。

`compileTS(name, source)` 支持可擦除的类型语法，暂不支持 `enum` 等需要生成运行时代码的语法。

## 浏览器

```ts
import { createMoeJS } from "moejs-wasm"

const engine = await createMoeJS({
  wasmURL: new URL("/moejs/moejs.wasm", location.href),
  workerURL: new URL("/moejs/worker.mjs", location.href)
})
```

请通过 HTTP(S) 提供静态资源，并保留 `lib/` 的目录结构。打包器改变 JS 所在位置时，显式设置 `wasmURL` 和 `workerURL`。

浏览器示例位于 `examples/browser/index.html`。

## Cloudflare Workers

包根入口会自动选择 Cloudflare 实现并加载 WASM：

```ts
import { createMoeJS } from "moejs-wasm"

export default {
  async fetch() {
    const engine = await createMoeJS()
    try {
      const mod = await engine.compile("edge.js", "export const add = (a, b) => a + b")
      const rt = await engine.newRuntime({ maxSteps: 100_000, memoryLimit: 4 * 1024 * 1024 })
      await rt.load(mod)
      return Response.json(await rt.call(mod.hook("add"), 20, 22))
    } finally {
      await engine.close()
    }
  }
}
```

完整入口与 Wrangler 配置位于 `examples/cloudflare/`。

Cloudflare 在当前 isolate 内执行。同步代码应设置 `maxSteps`，`timeoutMs` 依赖事件循环推进。部署前请检查 Worker 包大小、内存和平台配额。

## 公开入口与条件导出

默认入口会按运行环境选择实现，也可使用以下显式入口：

| 导入路径                | 行为                                              |
| ----------------------- | ------------------------------------------------- |
| `moejs-wasm`            | 自动选择环境；通常只需 `await createMoeJS()`      |
| `moejs-wasm/node`       | 显式选择 Node，自动使用 worker_threads            |
| `moejs-wasm/browser`    | 显式选择浏览器，自动使用 Web Worker               |
| `moejs-wasm/cloudflare` | 显式选择 Cloudflare，静态加载 WASM                |
| `moejs-wasm/wasm`       | 平台无关，在当前 JS realm 内执行；调用方提供 WASM |
| `moejs-wasm/moejs.wasm` | 原始 WASM 资源，供静态导入或自行加载              |

各入口均导出完整 API，可通过可选的 `adapter` 参数传入自定义 adapter。

### 通用 `/wasm` 入口

```ts
import { createMoeJS } from "moejs-wasm/wasm"

// Node 可从 fs.readFile 获得 Uint8Array；浏览器可传 fetch Response 或 URL。
// Cloudflare 传入静态导入得到的 WebAssembly.Module，避免动态 WASM 编译。
const engine = await createMoeJS({ wasm: wasmModuleOrBytes })
try {
  const script = await engine.compileScript("portable.js", "21 * 2")
  const runtime = await engine.newRuntime({ memoryLimit: 4 * 1024 * 1024 })
  console.log(await runtime.runScript(script)) // 42
} finally {
  await engine.close()
}
```

`wasm` 支持 `WebAssembly.Module`、`ArrayBuffer`／TypedArray、`Response`、URL 对象或 URL 字符串。此入口在当前 JS realm 内执行，同步代码应设置 `maxSteps`。

## 事件循环与网络

每个 Runtime 自动安装事件循环，以及定时器、`fetch`、Stream、AbortController、URL 等 Web API。`webAPI: false` 不安装 Web API（定时器仍由事件循环提供），之后可调用一次 `rt.installWebAPI()`。

网络访问默认关闭，可通过 `network.allowHosts`、`network.allow` 或自定义的 `network.fetch` 开启：

```ts
const rt = await engine.newRuntime({
  memoryLimit: 8 * 1024 * 1024,
  maxSteps: 1_000_000,
  network: { allowHosts: ["api.example.com"] }
})
```

`allowHosts` 按 hostname 匹配，支持 `*.example.com` 和 `*`；请求及重定向均需通过检查。主机名白名单无法限制解析后的 IP，私网和 DNS 安全仍需宿主网络环境保障。

`network.allow(request)` 支持异步授权。`network.fetch` 是宿主传输，相当于 MoeJS 的 `Client.Transport`：只设置它时与 nil `Allow` 一样放行所有主机，由它自己决定能访问什么。其余选项对应 `http.Client`：`timeoutMs`（`Client.Timeout`，超时的 `cause.code` 为 `ETIMEDOUT`）、`checkRedirect(request, via)`（返回 `false` 拒绝该跳，返回或抛出 `ErrUseLastResponse` 停在 3xx 响应）与 `jar`（`cookies(url)`／`setCookies(url, cookies)`）。`network.signal` 是父 context，中止原因成为错误的 cause（`AbortError` 对应 context canceled，`TimeoutError` 对应 deadline exceeded）；`rt.network.setContext(signal)`、`cancelContext()` 与 `close()` 对应 `webapi.API`。

请求通过 Go 的 `http.Client`（重定向、`CheckRedirect`、`Jar`、`Timeout` 均由 Go 处理）交给宿主 `fetch`，并带上 Go Transport 的默认头（`User-Agent: Go-http-client/1.1`、`Accept-Encoding: gzip`）、流式上传与原始状态文本。网络错误是 `TypeError: fetch failed`（读取响应体时为 `terminated`），宿主报告错误码时 `cause.code` 为 `ECONNREFUSED`、`ECONNRESET`、`ENOTFOUND` 或 `ETIMEDOUT`。平台限制：

- 平台 `fetch` 无法设置 `Host` 头，与 URL 主机不同的 `Host` 头会被拒绝；自定义 `fetch` 会收到它。
- 浏览器无法暴露重定向响应（`opaqueredirect`），因此会失败；自定义 `fetch` 返回已跟随重定向的响应时按 Transport 自行跟随处理。
- 浏览器不支持流式上传时请求体会先缓冲；脚本请求的 br／zstd 由平台解码后交给 guest；workerd 与浏览器不报告错误码。
- 浏览器还会施加 CORS、禁用请求头和隐藏 `Set-Cookie`，因此 `jar` 在浏览器中收不到 cookie；undici 会额外发送 `accept-language` 与 `sec-fetch-mode`。

每个异步任务（定时器、immediate、宿主任务与 Promise 结算）各自获得新的 `maxSteps` 预算，并受内存限制约束。

## 模块解析

静态 `import`、再导出和循环依赖通过 `engine.link(entry, resolve)` 链接。解析器支持异步编译并返回同一 Engine 的模块。

```ts
import { createMoeJS } from "moejs-wasm"

const engine = await createMoeJS({ timeoutMs: 5000 })
try {
  const dependency = await engine.compile("dep.js", "export const value = 21")
  const entry = await engine.compile(
    "entry.js",
    `
    import { value } from "dep"
    export async function run() {
      const dynamic = await import("dep")
      return { value: value + dynamic.value, url: import.meta.url }
    }
  `
  )
  const resolve = (_referrer, specifier) => {
    if (specifier === "dep") return dependency
    throw new Error(`Unknown module: ${specifier}`)
  }
  const linked = await engine.link(entry, resolve)
  const rt = await engine.newRuntime({
    maxSteps: 1_000_000,
    importer: { resolve, meta: (module) => ({ url: `app:///${module.name}` }) }
  })
  await rt.load(linked)
  console.log(await rt.call(linked.hook("run"))) // { value: 42, url: "app:///entry.js" }
} finally {
  await engine.close()
}
```

与 MoeJS `Importer.Resolve` 一致，每次动态 `import()` 都会调用 `importer.resolve(referrer, specifier)`；返回同一个 Module 得到同一个实例，返回 `null` 时 `import()` 以 TypeError 拒绝。`engine.link()` 的结果自带依赖图；未链接模块的静态导入会在同一次请求中一并解析，每个 Runtime 只解析一次（MoeJS 在 link 任务中解析，这是有意的性能取舍）。解析器抛出带 guest `value` 的 `MoeJSError` 时 `import()` 以该值拒绝，编译失败的 `syntax` 错误则成为 SyntaxError。`importer.meta(module, value)` 可自定义 `import.meta`。原生编译产物使用静态导入前，需要先通过原生 `Link` 链接。

## 编译与执行

| API                                                          | 行为                                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.compile`／`compileWith`／`compileTS`                 | 编译 ES 模块；选项包含 `typeScript`、`maxSteps`、`signal`、`timeoutMs`                                                                                   |
| `engine.link(entry, resolve, options?)`                      | 异步链接静态依赖，支持再导出和循环依赖                                                                                                                   |
| `module.exports`／`requests`／`hook(...path)`                | 导出名、静态依赖名和嵌套导出函数句柄                                                                                                                     |
| `engine.compileScript`／`compileScriptWith`                  | 编译经典脚本；`{ typeScript: true }` 支持可擦除类型                                                                                                      |
| `engine.compileFunction`／`compileFunctionTS`                | 参数为 `(name, params, body, options?)`；支持 `async`、`generator` 及两者组合                                                                            |
| `engine.newRuntime(options)`                                 | 创建独立全局环境与 WASM 实例，自动启动原生事件循环                                                                                                       |
| `rt.load(module)`                                            | 每个 Runtime 加载一个模块；有静态导入的模块须先经 `engine.link`。顶层 await 仍未完成时以 `ERR_MODULE_PENDING` 拒绝，模块保持已加载并在事件循环上继续执行 |
| `rt.call(hook, ...args)`／`callWith(hook, args, options)`    | 调用导出函数并等待返回的 Promise                                                                                                                         |
| `rt.runScript(script, options?)`                             | 执行可复用的经典脚本或编译函数；编译函数的完成值是函数句柄                                                                                               |
| `rt.evalScript(name, source, options?)`                      | 使用原生动态脚本编译与执行；遵守 `disableDynamicCode` 和 `maxDynamicSource`                                                                              |
| `rt.get(...path)`／`has(hook)`                               | 读取模块导出及成员／检查 Hook 是否可调用                                                                                                                 |
| `rt.export(name)`                                            | 返回 `{ value: Value, ok: boolean }`，区分不存在的导出和导出的 `undefined`                                                                               |
| `rt.module()`／`thrownValue(error)`／`stackTrace(exception)` | 查询真实已加载模块、宿主错误在 guest 中可捕获的值和当前 Error stack                                                                                      |
| `rt.close()`／`engine.close()`                               | 关闭端点；Engine 还会关闭其全部 Runtime 和编译端点                                                                                                       |

编译结果可在同一 Engine 的多个 Runtime 中使用。再导出 Hook 与所属链接图绑定。

### 时区与语言

- `locale`：Intl 与 `toLocaleString` 的默认语言，BCP 47 标签；空串或非法标签为 `en-US`（与 MoeJS `Options.Locale` 一致，不读取环境）。
- `timeZone`：`Date` 的本地时区，也是 `Intl.DateTimeFormat` 的默认时区，取值同 Go `time.LoadLocation`（IANA 名称区分大小写，`"UTC"`，`""` 为 UTC，`"Local"` 为宿主时区）；未知名称报错 `unknown time zone <name>`。
- 省略时等同 MoeJS 的 nil（`time.Local`）：每个 WASM 实例启动时读取宿主 `Intl.DateTimeFormat().resolvedOptions().timeZone`，用内置 tzdata 加载完整规则（含夏令时）；宿主无法提供名称或 Go 不认识该名称时，退回 Go js/wasm 的固定偏移。
- 原生接口：`realm.invoke("SetTimeZone", null)` 恢复宿主时区；`rt.native("engine")` 提供 `LoadLocation` 与 `FixedZone`。Intl 在首次使用时构建，MoeJS 的“每进程解码一次”在这里是每个 Runtime（WASM 实例）一次。

## 值传输与宿主函数

普通调用按值复制原始值、BigInt、数组、对象及常见内建类型，支持循环和共享引用。SharedArrayBuffer 也会复制，guest 的 Atomics 操作仅影响副本。

guest 函数、Promise 等值通过 `Value` 句柄操作。`callValue`、`runScriptValue`、`evalScriptValue`、`getValue` 和 `Value.callRaw` 保留原始 guest 值，包括 Symbol。

```ts
const object = await rt.getValue("service")
const fn = await object.get("run")
const result = await fn.call(object, 42) // 显式 this
const copied = await object.export()
await fn.release()
await object.release()
```

句柄仅在所属 Runtime 内有效，关闭 Runtime 会释放全部句柄；生命周期见下文“内存与句柄生命周期”。

普通宿主函数在 guest 中返回 Promise，参数是复制的宿主值。`rt.function(name, length, callback)` 对应 MoeJS `Runtime.Function`：同步执行，并像 `NativeFunc` 一样收到 live 的 `Value` 参数与 `this`，这些句柄只在本次调用内有效（之后再用会以 "Guest value has been released" 拒绝），需要保留的值应在回调内复制或另行获取：

```ts
await rt.setGlobal("host", {
  add: rt.function("add", 2, async (a, b) => Number(await a.toGo()) + Number(await b.toGo())),
  query: async (key) => lookup(key)
})
```

宿主回调和模块 resolver 可重入所属 Runtime，也可编译其他模块。回调内等待自身事件循环停止或退出的操作会被拒绝。

### JSON 与值操作

`Value` 提供 `get`、`has`、`export` 和 `appendJSON` 等操作，也可通过 Runtime 的同名方法调用。`rt.parseJSON()`、`toGo`、`unmarshal` 和 `toGoInto` 使用 MoeJS 原生转换，解码操作支持 `{ maxBytes, maxNodes }` 限制。

`Value` 的其余方法与 MoeJS 引擎方法一一对应（Go 方法名的 camelCase），键可以是字符串、数字或 Symbol：

- 属性：`get(key, { receiver })`、`lookup`、`getMethod`、`set`、`setProp`、`setV`、`createDataProperty(OrThrow)`、`defineOwnProperty`、`definePropertyOrThrow`、`getOwnProperty`、`delete`、`deletePropertyOrThrow`、`has`（`in` 运算符）、`hasProperty`、`hasOwn`、`ownKeys`、`enumerableOwnKeys`、`ownPropertyKeys`、`ownEnumerableStringKeys`。与 MoeJS 一样，`Object` 上的方法（`getOwnProperty`、`delete`、`hasProperty`、`ownPropertyKeys`、`freeze` 等）是普通操作，不运行 Proxy trap；`Realm` 上的方法（`ownKeys`、`hasOwn`、`prototypeOf`、`deletePropertyOrThrow`）会运行。
- 原型与完整性：`proto`、`prototypeOf`、`setPrototypeOf`、`preventExtensions`、`seal`、`freeze`、`isExtensible`、`isFrozen`、`isSealed`。
- 检查：`type`、`class()`、`isCallable`、`isConstructor`、`isArray`、`isRevokedProxy`、`isModuleNamespace`、`primitiveValue`、`string`、`displayString`、`typeOf`。不运行代码的操作在中断期间仍可使用。
- 转换：`toPrimitive(hint)`、`toNumber`、`toNumeric`、`toJSString`（`Realm.ToString`）、`toObject`、`toIntegerOrInfinity`、`toInt32`、`toUint32`、`toLength`、`toIndex`、`toBigInt`、`toBigInt64`、`toBigUint64`、`toPropertyKey`、`toBoolean`。
- 其他：`construct(args, newTarget)`、`arrayLength`、`push`、`setLength`、`bufferData`、`typedArrayElements`、`isDetachedBuffer`、`regExpExec`、`regExpData`、`iteratorNext`、`iteratorData`。字节总是复制，因为它们要跨越 worker／WASM 边界。

Runtime 提供 `construct`、`newObject`、`newObjectWithProto`、`newArray`、`newArrayLen`、`newRegExp`、`newArrayBuffer`、`detachArrayBuffer`、`global()`、`intrinsic(name)`，以及运算 `sameValue`、`sameValueZero`、`strictEquals`、`looseEquals`、`isLessThan`、`lessThan` 等、`add`、`instanceOf`、`ordinaryHasInstance` 与 `stringToBigInt`。`undefined`、`null`、布尔值与数字的句柄直接携带值，不占用槽位。

宿主数据路径：`fromHost`、`setGlobal` 与 `call` 参数会立即按结构复制普通 JS 值；`rt.fromGo(value)` 对应 MoeJS `Runtime.FromGo`，按需转换容器且键排序，`Date` 变为 RFC 3339 字符串，适合只读取一部分的大参数。`new RawMessage(text)` 对应 `json.RawMessage`：在 `fromGo` 中首次读取时才解析，未读取的值经 `toGo` 返回 `RawMessage`。`NativeHandle` 作为参数或全局值时按 `FromGo` 转换 Go 值。

### Realm 与原生接口

`rt.native()` 和 `rt.realm()` 返回 MoeJS 原生句柄。`rt.native("moejs")` 和 `rt.native("engine")` 提供公开包函数与常量，`methods()` 可查询签名。

```ts
const realm = await rt.realm()
const object = await realm.invoke<NativeHandle>("NewObject")
await object.invoke("DefinePropertyOrThrow", realm, "answer", {
  Value: 42,
  Writable: false,
  Enumerable: true,
  Configurable: false
})
const value = await object.asValue()
console.log(await value.export()) // { answer: 42 }
await value.release()
await object.release()
```

`NativeHandle` 提供 `invoke`、`call`、`getField`、`setField`、`read`、`asValue` 和 `release`。Go 多返回值映射为数组，错误会拒绝 Promise；指针、函数和结构体保留为句柄。句柄仅在所属 WASM 端点内有效。

独立沙盒请使用 `engine.newRuntime()`。原生 API 遵循 MoeJS 的调用约定和前置条件。

### 自定义解码

`newDecodeTarget()` 创建 Go 解码目标，供 `unmarshal*` 和 `toGoInto*` 使用。目标会原地更新并作为 `NativeHandle` 返回。

```ts
import { nativeTypes } from "moejs-wasm"

const target = await rt.newDecodeTarget(
  nativeTypes.struct([
    { name: "Count", type: "int16", tag: 'json:"count"' },
    { name: "Names", type: nativeTypes.slice("string"), tag: 'json:"names"' }
  ])
)
const source = await rt.parseJSONString('{"count":42,"names":["guest"]}')
await source.unmarshal(target)
console.log(await target.read()) // { Count: 42, Names: ["guest"] }
await target.release()
await source.release()
```

支持常见 Go 容器、结构体 tag、`time.Time`、`json.RawMessage` 和 MoeJS 公开类型。`JSONCodec` 与 `TextCodec` 可通过 `Decode`／`Encode` 回调实现自定义解码和编码。

### 内存与句柄生命周期

- 输入跨越边界时会复制一次（JS → JSON → Go 字符串）；此后引擎按 MoeJS 的方式保存字符串，ASCII 字符串不再复制，其他字符串保存为 UTF-16。`FromGo` 对宿主值的别名无法用于 JS 值。
- `Value` 与 `NativeHandle` 在宿主引用期间有效，不再引用后在下一次 JS GC 时自动释放；`release()` 立即释放。Cloudflare Workers 中 `FinalizationRegistry` 可能不会运行，应显式调用 `release()`。
- 宿主函数每次跨越边界都成为新的 guest 函数，guest 不再引用时释放；需要同一身份时先用 `rt.fromHost(fn)` 取得 `Value` 再传递。原生 LiveReporter（`NewNativeDataFunction` 的 `reportLive`）的回调随其函数一起释放。Symbol 两侧都只弱持有。
- 与 MoeJS 相同，`memoryLimit`、`stats().LiveBytes` 与 `rebaseAllocation()` 只统计 guest JS 可达的值；只由宿主持有的值需用 `addLiveRoots` 注册。
- 丢弃的 Script／Module 描述符会释放各端点保存的字节码；使用 `import()`、`import.meta` 或直接 `eval` 的脚本在 Engine 生命周期内保留，Runtime 加载过的模块随 Runtime 保留。
- 每个 Runtime 是独立的 Go 实例，WebAssembly 内存不会收缩，高水位会一直保留，常驻内存约为 Go live heap 的两倍。`newRuntime({ goMemoryLimit, gcPercent })` 对应该实例的 `GOMEMLIMIT` 与 `GOGC`；建议将 `goMemoryLimit` 设在峰值之上，`gcPercent` 保持默认。

### 内存 roots

`rt.addLiveRoots(valuesOrCallback)` 注册动态 roots，并返回移除函数；`rt.rebaseAllocation(valuesOrCallback?)` 重新计算分配预算。只需注册仅由宿主持有的值；测量回调仅用于报告现有值和字节数。

```ts
const remove = await rt.addLiveRoots((add) => {
  for (const value of pendingValues) add(value)
})
await rt.rebaseAllocation()
await remove()
```

## Promise 与事件循环控制

`rt.newPromise()` 对应 MoeJS `Runtime.NewPromise`：结算立即生效并运行它排队的任务，不占用事件循环；`rt.eventLoop.newPromise()` 对应 `Loop.NewPromise`：在结算前保持事件循环运行，并在循环上结算，`settle(fn)` 在循环上运行 `fn`，其返回值兑现、抛出值拒绝。Terminate 之后结算不做任何事。`rt.promiseState()` 读取任意值的 Promise 状态（与 `PromiseResult` 一致：不运行代码，非 Promise 时 `ok` 为 `false`）。`rt.setPromiseRejectionTracker()` 与 `onPromiseRejection` 在引起拒绝或处理的操作中同步运行。

`rt.eventLoop` 提供 `start()`、`run()`、`stop()`、`post()`、`interrupt()` 和 `terminate()` 等控制方法。`newRuntime()` 会自动启动事件循环，第一次 `start()` 或 `run()` 接管这次启动，此后与 MoeJS 一样，循环已在运行时再次调用会以 `ERR_LOOP_RUNNING` 拒绝。`run(fn)` 先在循环上调用 `fn`，`fn` 抛出时 `run()` 以该错误拒绝。不带任务的 `runOnLoop()`／`post()` 只报告循环是否存活；宿主任务的参数是 Runtime。`eventLoop.onError(error)` 在循环上同步运行，`error` 是 `MoeJSError`，其中的 `Value` 在回调结束后仍可使用。`newRuntime({ eventLoop: false })` 得到没有定时器、Web API 和事件循环的 Runtime；`rt.newEventLoop()` 在这种 Runtime 上或 `terminate()` 之后创建新的循环（不会自动启动），Web API 仍绑定在第一个循环上。`eventLoop.onError` 可处理原生回调错误，`eventLoop.resetMemoryPerTask` 可按任务重置分配预算。与 MoeJS `Loop.Run` 一致，`run(options?)` 默认没有截止时间，可传入 `timeoutMs` 或 `signal`。

`post()` 支持同步和异步宿主任务，任务错误由 `onError` 或 `run()` 的拒绝处理。

## 运行时限制、恢复与错误

- 不可信脚本应设置 `memoryLimit` 和 `maxSteps`。`maxSteps` 是每个任务的执行步数：每个宿主请求，以及事件循环的每个定时器、immediate 与任务回调（连同其排队的 Promise 任务）都获得新的预算。未设置时为 1,000,000；与 `memoryLimit` 相同，`0` 或负数表示不限制。预算耗尽与内存超限一样会中断 Runtime。与 MoeJS 一样，后台回调（如 `setInterval`）每次都获得新预算，`eventLoop.run()` 默认也没有截止时间，没有待完成请求的 Runtime 可以一直运行；运行不可信代码时应自行 `interrupt()` 或 `close()` 空闲的 Runtime。
- `timeoutMs` 默认 1000。在 Node worker 与跨源隔离（cross-origin isolated）的浏览器中，`rt.interrupt()`、`eventLoop.interrupt()`、`timeoutMs` 与 `signal` 能停止正在运行的同步代码，包括正则回溯、动态编译（`eval`／`Function`／`evalScript`）与内存测量；未跨源隔离的浏览器没有 `SharedArrayBuffer`，中断只在宿主调用、等待或 `maxSteps` 耗尽时生效。通用 WASM 与 workerd 在当前 realm 内执行，同步代码运行时宿主线程被阻塞，中断只能从宿主回调发出，因此同步代码必须设置正的 `maxSteps`。同步宿主回调或 resolver 内重入运行的 guest 代码同样可被抢占；它停在中途时到达的重入请求（包括控制操作）按顺序排队，待其停止后执行。与 MoeJS 的嵌套调用一致，同步宿主回调若在它发起的重入调用结束前返回，外层 guest 调用会等该重入调用结束后再继续。自定义宿主须使用随包发布的入口，它们提供 Go 读取中断的 `moejs.interruptSeq` 导入。编译的 `timeoutMs` 由 Go 侧截止时间执行，因此在当前 realm 内同样有效（workerd 冻结时钟时除外）；中止或超时的编译只拒绝它自己，其他排队的编译与链接会在新的编译端点上继续。
- 内存计数规则与 MoeJS 相同。宿主值（`fromHost`、`setGlobal`、`call` 参数、宿主函数返回值与 Promise 结算值）按结构复制进 realm，像 `ParseJSON` 的副本一样计入容器，解码期间测量会等待；字符串和 ArrayBuffer 的字节在创建时不计入，与 `FromGo` 相同。未完成的调用作为 live roots 计入；宿主持有的 `Value` 与 `NativeHandle` 不计入，需要时用 `addLiveRoots` 注册。
- 未显式设置时，携带代码的请求（编译、链接、加载与 `runScript`）会按代码量延长超时，约每 KB 增加 1ms；编译预算 `maxSteps` 也会按源码长度放宽，显式设为 0 或负数时不限制。9MB 级别的 bundle 使用默认选项即可编译和运行。与 MoeJS 的 `Link` 一致，默认情况下 `engine.link()` 只为链接请求本身计时，解析器不受超时限制；需要整体上限时传入 `timeoutMs` 或 `signal`。
- 大型代码请使用 `compileScript()`／`compile()` 后再 `runScript()`／`load()`。`evalScript()` 与 guest 的 `eval` 受 `maxDynamicSource`（默认 1 MiB）限制。同一 Runtime 已加载的字节码只按 id 传递，不会重复发送。
- `createMoeJS({ warmRuntimes: 1 })` 在后台预先启动 Runtime 的 worker 与 Go 实例，`newRuntime()` 可跳过约 25ms 的启动。每个预热实例占用一个空闲 worker，仅对 Node 与浏览器的 worker 适配器有效。
- 与 MoeJS 一致，中断在 guest 实际停止时才以 `InterruptedError` 拒绝正在运行的调用，排队的请求随后在 Go 中依次因该中断失败；只有超时或中止的请求自身会立即拒绝。预算耗尽、超时或中断后，调用 `await rt.clearInterrupt()` 再复用 Runtime（宿主回调内也可调用）；没有待处理中断时它不会停止任何东西。中断停止了事件循环时，通过 `rt.eventLoop.start()` 或 `run()` 继续处理异步任务。
- `rt.stats()` 返回运行时计数器；`resetAllocation()`、`releaseCallData()` 和 `rebaseAllocation()` 用于管理分配预算；`measureLive(roots?)` 在有无内存限制时都能测量，且不改变计数器。
- 错误统一为 `MoeJSError`，每层对应 MoeJS 的一个 Go 错误，`cause` 是下一层。`code` 对应 MoeJS 的哨兵与类型错误（如 `ERR_INTERRUPTED`、`ERR_MEMORY_LIMIT`、`ERR_EXECUTION_BUDGET`、`ERR_TIMEOUT`、`ERR_INTERNAL`、`ERR_SYNTAX`、`ERR_HOOK_NOT_FOUND`、`ERR_NOT_CALLABLE`、`ERR_FOREIGN`、`ERR_MODULE_PENDING`、`ERR_NO_RESOLVER`、`ERR_MODULE_RESOLVE`、`ERR_LOOP_TERMINATED`、`ERR_LOOP_RUNNING`），`error.is(code | object)` 像 `errors.Is` 一样沿 `cause` 查找。
- 与 MoeJS 一致，所有中断引起的停止（内存命中、预算耗尽、请求自身的 `signal`／`timeoutMs`）都以 `kind: "interrupted"` 的 `InterruptedError` 拒绝，具体错误在 `cause` 中；`rebaseAllocation()` 的 `MemoryLimitError` 不经中断直接返回（`allocated` 为 0）。`interrupt(reason)` 的消息为 `interrupted` 或 `interrupted: <reason>`，`value`／`reason` 保持原对象的身份。Worker 或 Go 实例退出时以 `kind: "fatal"` 拒绝。
- 宿主函数抛出的 guest `Value` 原样抛给 guest，其他值成为 `Error`，未捕获时 `cause` 保留宿主原错误的身份。

沙盒仅提供 JS 标准库、事件循环、Web API 和显式安装的 globals。存储等宿主能力应通过权限受限的宿主函数提供。

Go 指针与函数通过句柄管理，Go 目标通过反射类型映射。

## 许可证

Apache-2.0

MoeJS 使用 Apache-2.0，Go 运行时使用 BSD 许可证。相关许可证和第三方声明随发布包提供。
