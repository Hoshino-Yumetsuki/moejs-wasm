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

请使用 `yarn build` 构建，该命令会通过临时 Go overlay 加入执行预算。

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

## API 与限制

| API                                         | 行为                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| `engine.compile(name, source)`／`compileTS` | 编译模块，返回 `Module`                                         |
| `module.exports`／`requests`                | 导出名与静态依赖名；`hook(...path)` 创建嵌套导出函数句柄        |
| `engine.compileScript(name, source)`        | 编译经典脚本，返回可重复执行的 `Script`                         |
| `engine.newRuntime(options)`                | 独立全局环境和 WASM 实例                                        |
| `rt.setGlobal(name, value)`                 | 显式安装数据或宿主函数命名空间                                  |
| `rt.load(module)`                           | 每个 Runtime 只能加载一个模块一次                               |
| `rt.call<T>(hook, ...args)`                 | 调用已加载模块的函数并等待返回的 Promise                        |
| `rt.runScript<T>(script)`                   | 执行经典脚本，返回完成值                                        |
| `rt.get<T>(...path)`                        | 读取已加载模块的导出及成员                                      |
| `rt.stats()`                                | 返回 MoeJS 原始字段名的计数器，如 `AllocatedBytes`、`LiveBytes` |
| `rt.resetAllocation()`／`releaseCallData()` | 重置分配预算／释放调用参数持有的数据                            |
| `rt.interrupt()`／`close()`                 | 立即拒绝未完成操作并销毁端点；不复用该 Runtime                  |
| `engine.close()`                            | 关闭编译端点和所有 Runtime                                      |

常用 Runtime options 包括 `memoryLimit`、`maxSteps`、`timeoutMs`、`disableDynamicCode`、`maxDynamicSource`、`mutableIntrinsics`、`locale` 和 `timeZone`。

- 不可信脚本应设置 `memoryLimit` 和 `maxSteps`；内存限制仅统计 guest 分配。
- `timeoutMs` 默认 1000。超时、中断或预算耗尽后，请关闭并重新创建 Runtime。
- 对象按值传输；支持常见原始值、BigInt、数组和普通对象。循环引用、Symbol、宿主非普通对象及 guest 函数不受支持。
- 宿主函数通过 `setGlobal` 显式安装，在 guest 中始终返回 Promise，应使用 `await`。宿主回调不得重新进入同一 Runtime。
- 错误统一为 `MoeJSError`，可通过 `kind` 区分错误类型。

沙盒默认仅包含 JS 标准库和显式安装的 globals。动态 import 默认拒绝，带静态 import 的模块目前无法加载。网络和存储等能力应通过权限受限的宿主函数提供。

## 许可证

Apache-2.0

MoeJS 使用 Apache-2.0，Go 运行时使用 BSD 许可证。相关许可证和第三方声明随发布包提供。
