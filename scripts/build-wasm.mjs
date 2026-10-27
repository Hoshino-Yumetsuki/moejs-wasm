import { execFileSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { generateNativeRegistry } from "./native-registry.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const go = process.env.GO || "go"
const goroot = execFileSync(go, ["env", "GOROOT"], { encoding: "utf8", cwd: root }).trim()
const output = join(root, "lib")
const temporary = await mkdtemp(join(tmpdir(), "moejs-wasm-"))
const replacements = {}

// Keep upstream checkout pristine. Go's overlay supplies the small deterministic
// execution budget needed on platforms whose clocks freeze during synchronous JS.
async function overlay(relative, transform) {
  const original = join(root, "external", "moejs", relative)
  const target = join(temporary, relative.replaceAll("/", "_"))
  const source = (await readFile(original, "utf8")).replaceAll("\r\n", "\n")
  const transformed = transform(source)
  if (transformed === source) throw new Error(`Upstream overlay anchor missing: ${relative}`)
  await writeFile(target, transformed)
  replacements[original] = target
}
function replaceOnce(source, anchor, replacement) {
  if (!source.includes(anchor) || source.indexOf(anchor) !== source.lastIndexOf(anchor)) {
    throw new Error(`Expected unique upstream overlay anchor: ${anchor}`)
  }
  return source.replace(anchor, replacement)
}

try {
  await mkdir(output, { recursive: true })
  await generateNativeRegistry(root)
  await overlay(
    "module.go",
    (source) =>
      source +
      `
// ModuleFromBytecode is the WASM bridge's verified-artifact entry point.
func (*Module) MoeJSModuleFromBytecode(code, early *bytecode.Function, ts bool) *Module {
    m := &Module{code: code, ts: ts}
    m.early.Store(early)
    return m
}
func (m *Module) LinkedGraph() *engine.ModuleGraph {
    if m.graph == nil { return nil }
    return m.graph.g
}
`
  )
  await overlay(
    "script.go",
    (source) =>
      source +
      `
func (*Script) MoeJSScriptFromBytecode(code *bytecode.Function) *Script {
    return &Script{name: code.Source.Name, code: code}
}
`
  )
  await overlay("runtime.go", (source) => {
    source = replaceOnce(
      source,
      "type Runtime struct {",
      "type Runtime struct {\n\tmoduleEvaluationPromise *engine.Object"
    )
    source = replaceOnce(
      source,
      "rt.env, p, err = r.EvaluateModuleAsync(m.code)",
      "rt.env, p, err = r.EvaluateModuleAsync(m.code)\n\trt.moduleEvaluationPromise = p"
    )
    source = replaceOnce(
      source,
      "rt.env, p, err = r.EvaluateGraph(g)",
      "rt.env, p, err = r.EvaluateGraph(g)\n\trt.moduleEvaluationPromise = p"
    )
    return (
      source +
      `
func (rt *Runtime) ModuleEvaluationPromise() *engine.Object { return rt.moduleEvaluationPromise }
func (rt *Runtime) SetImporter(imp *Importer) {
    if imp == nil { rt.realm.SetImportHooks(nil); return }
    rt.realm.SetImportHooks(imp.engineHooks())
}
`
    )
  })
  await overlay("engine/realm.go", (source) =>
    replaceOnce(
      source,
      "type Realm struct {",
      "type Realm struct {\n\texecutionBudget int64\n\texecutionBudgetError error"
    )
  )
  await overlay("engine/interrupt.go", (source) => {
    source = replaceOnce(
      source,
      "func (r *Realm) CheckInterrupt() error {",
      "func (r *Realm) CheckInterrupt() error {\n\tif err := r.checkExecutionBudget(); err != nil { return err }"
    )
    return (
      source +
      `
// SetExecutionBudget bounds VM dispatches and native interrupt checkpoints.
// The bridge resets this only for a new external operation, never host settlement.
func (r *Realm) SetExecutionBudget(steps int64, exhausted error) {
    r.executionBudget = steps
    r.executionBudgetError = exhausted
}

func (r *Realm) checkExecutionBudget() error {
    if r.interruptFlag.Load() < 0 { return r.interruptError() }
    if r.executionBudget == 0 { return nil } // intrinsic initialization
    r.executionBudget--
    if r.executionBudget <= 0 {
        r.executionBudget = -1
        r.Interrupt(r.executionBudgetError)
        return r.interruptError()
    }
    return nil
}
`
    )
  })
  for (const file of ["engine/interp_run.go", "engine/interp_run_regcheck.go"]) {
    await overlay(file, (source) =>
      replaceOnce(
        source,
        "\tfor {\n\t\tvar (",
        "\tfor {\n\t\tif err := r.checkExecutionBudget(); err != nil { return Undefined(), err }\n\t\tvar ("
      )
    )
  }
  await overlay(
    "engine/builtin_promise_host.go",
    (source) =>
      source +
      `
// ObservePromise attaches a host completion reaction without consulting guest
// properties, constructors, species, or Promise.prototype.then.
func (r *Realm) ObservePromise(value Value, notify func()) bool {
    if !isPromise(value) { return false }
    r.promiseReact(value.AsObject(), hostPromiseObserver(notify))
    return true
}

type hostPromiseObserver func()

func (notify hostPromiseObserver) promiseSettled(_ *Realm, _ Value, _ bool) error {
    notify()
    return nil
}
`
  )
  const overlayFile = join(temporary, "overlay.json")
  await writeFile(overlayFile, JSON.stringify({ Replace: replacements }))
  execFileSync(
    go,
    [
      "build",
      "-overlay",
      overlayFile,
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      join(output, "moejs.wasm"),
      "./bridge"
    ],
    {
      cwd: root,
      env: { ...process.env, GOOS: "js", GOARCH: "wasm", CGO_ENABLED: "0" },
      stdio: "inherit"
    }
  )
  const shimPath = join(goroot, "lib", "wasm", "wasm_exec.js")
  const shim = await readFile(shimPath, "utf8")
  await copyFile(shimPath, join(output, "wasm_exec.js"))
  await copyFile(join(root, "external", "moejs", "LICENSE"), join(root, "LICENSE-moejs"))
  await copyFile(
    join(root, "external", "moejs", "THIRD_PARTY_NOTICES"),
    join(root, "LICENSE-moejs-THIRD_PARTY_NOTICES")
  )
  await copyFile(join(goroot, "LICENSE"), join(root, "LICENSE-go"))
  // A lexical globalThis makes syscall/js and Go's timers instance-local. Do not
  // use eval/new Function: the generated factory also runs under Workers CSP.
  await writeFile(
    join(output, "go-shim.mjs"),
    `export function createGo(globalThis) {\nconst {crypto, performance, TextEncoder, TextDecoder, setTimeout, clearTimeout, console, Date} = globalThis;\n${shim}\nconst fs = globalThis.fs;\nreturn new globalThis.Go();\n}\n`
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
