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

请使用 `yarn build` 构建，该命令通过临时 Go overlay 接入执行预算和 Promise 观察。

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

每个 Runtime 自动安装事件循环，以及定时器、`fetch`、Stream、AbortController、URL 等 Web API。

网络访问默认关闭，可通过 `network.allowHosts` 或 `network.allow` 显式授权：

```ts
const rt = await engine.newRuntime({
  memoryLimit: 8 * 1024 * 1024,
  maxSteps: 1_000_000,
  network: { allowHosts: ["api.example.com"] }
})
```

`allowHosts` 按 hostname 匹配，支持 `*.example.com` 和 `*`；请求及重定向均需通过检查。主机名白名单无法限制解析后的 IP，私网和 DNS 安全仍需宿主网络环境保障。

`network.allow(request)` 支持异步授权，`network.fetch` 可注入宿主传输。网络使用宿主 `fetch`，浏览器仍受 CORS 限制。

异步任务同样受执行预算和内存限制约束。

## 模块解析

静态 `import`、再导出和循环依赖通过 `engine.link(entry, resolve)` 链接。解析器可以异步编译并返回同一 Engine 的模块；没有隐式文件系统或网络模块加载。

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

动态 `import()` 使用 `importer.resolve(referrer, specifier)`，并与静态导入共享模块实例和缓存。`importer.meta(module)` 可自定义 `import.meta` 元数据。

## 编译与执行

| API                                                       | 行为                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `engine.compile`／`compileWith`／`compileTS`              | 编译 ES 模块；选项包含 `typeScript`、`maxSteps`、`signal`、`timeoutMs`        |
| `engine.link(entry, resolve, options?)`                   | 异步链接静态依赖，支持再导出和循环依赖                                        |
| `module.exports`／`requests`／`hook(...path)`             | 导出名、静态依赖名和嵌套导出函数句柄                                          |
| `engine.compileScript`／`compileScriptWith`               | 编译经典脚本；`{ typeScript: true }` 支持可擦除类型                           |
| `engine.compileFunction`／`compileFunctionTS`             | 参数为 `(name, params, body, options?)`；支持 `async`、`generator` 及两者组合 |
| `engine.newRuntime(options)`                              | 创建独立全局环境与 WASM 实例，自动启动原生事件循环                            |
| `rt.load(module)`                                         | 每个 Runtime 加载一个模块一次                                                 |
| `rt.call(hook, ...args)`／`callWith(hook, args, options)` | 调用导出函数并等待返回的 Promise                                              |
| `rt.runScript(script, options?)`                          | 执行可复用的经典脚本或编译函数；编译函数的完成值是函数句柄                    |
| `rt.evalScript(name, source, options?)`                   | 使用原生动态脚本编译与执行；遵守 `disableDynamicCode` 和 `maxDynamicSource`   |
| `rt.get(...path)`／`has(hook)`                            | 读取模块导出及成员／检查 Hook 是否可调用                                      |
| `rt.export(name)`                                         | 返回 `{ value: Value, ok: boolean }`，区分不存在的导出和导出的 `undefined`    |
| `rt.close()`／`engine.close()`                            | 关闭端点；Engine 还会关闭其全部 Runtime 和编译端点                            |

编译结果可在同一 Engine 的多个 Runtime 中使用。

## 值传输与宿主函数

普通调用按值复制原始值、BigInt、数组、普通对象及常见内建类型，支持循环和共享引用。

guest 函数、Symbol、Promise 等值通过 `Value` 句柄操作。`callValue`、`runScriptValue`、`evalScriptValue`、`getValue` 和 `Value.callRaw` 可保留原始 guest 值。

```ts
const object = await rt.getValue("service")
const fn = await object.get("run")
const result = await fn.call(object, 42) // 显式 this
const copied = await object.export()
await fn.release()
await object.release()
```

句柄仅在所属 Runtime 内有效，用后应调用 `release()`；关闭 Runtime 会释放全部句柄。

普通宿主函数在 guest 中返回 Promise。需要同步函数时，使用 `rt.function(name, length, callback)` 或 `defineHostFunction()`：

```ts
await rt.setGlobal("host", {
  add: rt.function("add", 2, (a, b) => Number(a) + Number(b)),
  query: async (key) => lookup(key)
})
```

宿主回调可通过 `Value` 或 `rt.callFunction()` 调用 guest 函数。

### JSON 与值操作

`Value` 提供 `get`、`has`、`export` 和 `appendJSON` 等操作，也可通过 Runtime 的同名方法调用。`rt.parseJSON()`、`toGo`、`unmarshal` 和 `toGoInto` 使用 MoeJS 原生转换，解码操作支持 `{ maxBytes, maxNodes }` 限制。

## Promise 与事件循环控制

`rt.newPromise()` 创建 guest Promise，`rt.promiseState()` 查询状态，`rt.setPromiseRejectionTracker()` 监听拒绝。

`rt.eventLoop` 提供 `start()`、`run()`、`stop()`、`post()`、`interrupt()` 和 `terminate()` 等控制方法。`eventLoop.onError` 可处理原生回调错误，`eventLoop.resetMemoryPerTask` 可按任务重置分配预算。

## 运行时限制、恢复与错误

- 不可信脚本应设置 `memoryLimit` 和 `maxSteps`；内存限制仅统计 guest 分配。
- `timeoutMs` 默认 1000。通用 WASM 与 workerd 在当前 realm 内执行，同步代码必须设置 `maxSteps`。
- 预算耗尽、超时或中断后，调用 `await rt.clearInterrupt()` 再复用 Runtime，并通过 `rt.eventLoop.start()` 或 `run()` 继续处理异步任务。
- `rt.stats()` 返回运行时计数器；`resetAllocation()`、`releaseCallData()` 和 `rebaseAllocation()` 用于管理分配预算。
- 错误统一为 `MoeJSError`，包含 `kind`、源码位置和可用的 guest stack。

沙盒仅提供 JS 标准库、事件循环、Web API 和显式安装的 globals。存储等宿主能力应通过权限受限的宿主函数提供。

## 许可证

Apache-2.0

MoeJS 使用 Apache-2.0，Go 运行时使用 BSD 许可证。相关许可证和第三方声明随发布包提供。
