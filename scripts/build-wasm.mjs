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

// Keep upstream checkout pristine; the overlay adds the per-task execution budget and the host interrupt poll.
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
function replaceEach(source, anchor, replacement, count) {
  if (source.split(anchor).length - 1 !== count)
    throw new Error(`Expected ${count} upstream overlay anchors: ${anchor}`)
  return source.replaceAll(anchor, replacement)
}

try {
  await mkdir(output, { recursive: true })
  await generateNativeRegistry(root)
  await overlay("module.go", (source) => {
    // Decode the early-exports variant only when Link needs it.
    source = replaceOnce(
      source,
      "\tts   bool // CompileTS compiled it\n}",
      "\tts   bool // CompileTS compiled it\n\tloadEarly func() (*bytecode.Function, error)\n}"
    )
    source = replaceOnce(
      source,
      "\tif code := m.early.Load(); code != nil {\n\t\treturn code, nil\n\t}\n",
      "\tif code := m.early.Load(); code != nil {\n\t\treturn code, nil\n\t}\n" +
        "\tif m.loadEarly != nil {\n\t\tcode, err := m.loadEarly()\n\t\tif err != nil {\n\t\t\treturn nil, err\n\t\t}\n" +
        "\t\tif !m.early.CompareAndSwap(nil, code) {\n\t\t\tcode = m.early.Load()\n\t\t}\n\t\treturn code, nil\n\t}\n"
    )
    return (
      source +
      `
// ModuleFromBytecode is the WASM bridge's verified-artifact entry point.
func (*Module) MoeJSModuleFromBytecode(code *bytecode.Function, early func() (*bytecode.Function, error), ts bool) *Module {
    return &Module{code: code, ts: ts, loadEarly: early}
}
`
    )
  })
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
  await overlay("engine/realm.go", (source) =>
    replaceOnce(
      source,
      "type Realm struct {",
      "type Realm struct {\n\texecutionBudget int64\n\texecutionSlice int64\n\texecutionBudgetError error\n\texecutionSteps int64\n\texecutionLimited bool\n\thostInterruptPoll func()\n\tnativePolls uint32"
    )
  )
  await overlay("engine/interrupt.go", (source) => {
    source = replaceOnce(
      source,
      "func (r *Realm) CheckInterrupt() error {",
      "func (r *Realm) CheckInterrupt() error {\n\tif err := r.nativeCheckpoint(); err != nil { return err }"
    )
    return (
      source +
      `
// executionSliceSteps is how many steps run between two polls of the host's interrupt word.
const executionSliceSteps = 1024

// nativePollEvery is how many native CheckInterrupts share one poll: each costs a call out to the host.
const nativePollEvery = 16

// SetExecutionBudget sets the steps each task may run; steps <= 0 means no limit.
func (r *Realm) SetExecutionBudget(steps int64, exhausted error) {
    r.executionSteps = max(steps, 0)
    r.executionBudgetError = exhausted
    r.RefillExecutionBudget()
}

// RefillExecutionBudget starts a task's budget where eventloop's ResetMemoryPerTask resets memory.
func (r *Realm) RefillExecutionBudget() {
    r.executionLimited = r.executionSteps > 0
    r.executionBudget = max(r.executionSteps-1, 0)
    r.executionSlice = 0
    // The first slice is charged here, so a short task never polls the host.
    if !r.executionLimited {
        r.executionSlice = executionSliceSteps
    } else if r.executionBudget > 0 {
        n := min(executionSliceSteps, r.executionBudget)
        r.executionBudget -= n
        r.executionSlice = n
    }
}

// SetHostInterruptPoll installs a poll that lets a host interrupt reach the realm while it runs.
func (r *Realm) SetHostInterruptPoll(poll func()) { r.hostInterruptPoll = poll }

// BeginHolding makes measurements wait while the host decodes values only Go holds, as JSON.parse does.
func (r *Realm) BeginHolding() bool { return r.holdingBegin() }

func (r *Realm) EndHolding(began bool) { r.holdingEnd(began) }

// checkExecutionBudget stays inlinable: a step only decrements the slice.
func (r *Realm) checkExecutionBudget() error {
    if r.executionSlice > 0 {
        r.executionSlice--
        return nil
    }
    return r.executionCheckpoint()
}

// executionCheckpoint ends a slice; a pending interrupt is left to upstream's own checks.
//
//go:noinline
func (r *Realm) executionCheckpoint() error {
    if r.hostInterruptPoll != nil { r.hostInterruptPoll() }
    if !r.executionLimited || r.interruptFlag.Load() < 0 {
        r.executionSlice = executionSliceSteps - 1
        return nil
    }
    if r.executionBudget <= 0 {
        r.Interrupt(r.executionBudgetError)
        return r.interruptError()
    }
    n := min(executionSliceSteps, r.executionBudget)
    r.executionBudget -= n
    r.executionSlice = n - 1
    return nil
}

//go:noinline
func (r *Realm) nativeCheckpoint() error {
    if r.nativePolls++; r.nativePolls%nativePollEvery == 0 && r.hostInterruptPoll != nil { r.hostInterruptPoll() }
    return r.checkExecutionBudget()
}

// jobCheckpoint is CheckInterrupt for each job, without a host poll per job.
func (r *Realm) jobCheckpoint() error {
    if err := r.checkExecutionBudget(); err != nil { return err }
    if r.interruptFlag.Load() < 0 { return r.interruptError() }
    return nil
}
`
    )
  })
  await overlay("engine/jobs.go", (source) =>
    replaceOnce(
      source,
      "\t\tif ierr := r.CheckInterrupt(); ierr != nil {\n\t\t\tr.dropJobs(nil, ierr)",
      "\t\tif ierr := r.jobCheckpoint(); ierr != nil {\n\t\t\tr.dropJobs(nil, ierr)"
    )
  )
  // A heap walk polls the host too, so an interrupt made while it measures ends it.
  await overlay("engine/memlive.go", (source) =>
    replaceOnce(
      source,
      "\tif w.work++; w.work%liveCheckEvery == 0 && w.r.interruptValue.Load() != w.start {\n\t\tw.stopped = true\n\t}\n}",
      "\tif w.work++; w.work%liveCheckEvery == 0 {\n\t\tw.checkpoint()\n\t}\n}\n\n//go:noinline\nfunc (w *liveWalker) checkpoint() {\n\tif w.r.hostInterruptPoll != nil {\n\t\tw.r.hostInterruptPoll()\n\t}\n\tif w.r.interruptValue.Load() != w.start {\n\t\tw.stopped = true\n\t}\n}"
    )
  )
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
  await overlay("eventloop/eventloop.go", (source) => {
    // The loop's own interrupt checks must not spend the steps of JavaScript.
    source = replaceEach(
      source,
      "\t\tl.err = l.rt.Realm().CheckInterrupt()\n",
      "\t\tl.err = l.interruptPending()\n",
      2
    )
    source = replaceOnce(
      source,
      "func (l *Loop) call(fn, this moejs.Value, args []moejs.Value) error {\n\t_, err := l.rt.CallFunction(fn, this, args...)\n",
      "func (l *Loop) call(fn, this moejs.Value, args []moejs.Value) error {\n\tl.rt.Realm().RefillExecutionBudget()\n\t_, err := l.rt.CallFunction(fn, this, args...)\n"
    )
    source = replaceOnce(
      source,
      "\t\tif l.fail(task(l.rt)) {\n",
      "\t\tl.rt.Realm().RefillExecutionBudget()\n\t\tif l.fail(task(l.rt)) {\n"
    )
    return (
      source +
      `
// interruptPending is CheckInterrupt without the step the overlay charges there.
func (l *Loop) interruptPending() error {
    if r := l.rt.Realm(); r.Interrupted() {
        return r.CheckInterrupt()
    }
    return nil
}
`
    )
  })
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
