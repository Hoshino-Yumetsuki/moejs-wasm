import { defineConfig } from "tsdown"

export default defineConfig([
  {
    entry: {
      index: "src/browser.ts",
      node: "src/node.ts",
      cloudflare: "src/cloudflare.ts",
      wasm: "src/wasm.ts"
    },
    format: ["esm", "cjs"],
    platform: "neutral",
    outDir: "lib",
    target: "es2022",
    dts: true,
    clean: true,
    minify: true,
    deps: { neverBundle: [/^node:/, /go-shim\.mjs$/, /\.wasm$/] },
    outExtensions({ format }) {
      return { js: format === "es" ? ".mjs" : ".cjs", dts: format === "es" ? ".d.ts" : ".d.cts" }
    }
  },
  {
    entry: ["src/worker.ts"],
    format: ["esm"],
    platform: "neutral",
    outDir: "lib",
    target: "es2022",
    clean: false,
    dts: false,
    minify: true,
    deps: { neverBundle: [/^node:/, /go-shim\.mjs$/] },
    outExtensions: () => ({ js: ".mjs" })
  }
])
