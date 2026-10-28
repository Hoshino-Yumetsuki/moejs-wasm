import { afterEach, expect, it } from "vitest"
import {
  createMoeJS,
  nativeTypes,
  RawMessage,
  Value,
  type Engine,
  type IntrinsicName,
  type RuntimeOptions
} from "moejs-wasm"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})

const fixture = `
  export const sym = Symbol("s")
  export const log = []
  export const obj = { [sym]: 1, 2: "two", tag: "own", get who() { return this.tag } }
  export const frozen = Object.freeze({ a: 1 })
  export const proxy = new Proxy({ x: 1 }, {
    get(t, k) { log.push("get"); return 9 },
    ownKeys() { log.push("ownKeys"); return ["x"] },
    getOwnPropertyDescriptor(t, k) { log.push("gopd"); return Reflect.getOwnPropertyDescriptor(t, k) },
    deleteProperty(t, k) { log.push("deleteProperty"); return true },
    getPrototypeOf() { log.push("getPrototypeOf"); return Array.prototype }
  })
  export const revocable = Proxy.revocable({}, {})
  export const callableProxy = new Proxy(function () {}, {})
  export const wrapper = new Number(5)
  export const arrow = () => 1
  export class A { constructor() { this.nt = new.target.name } }
  export class B extends A {}
  export const iter = [1, 2][Symbol.iterator]()
  export const siter = "ab"[Symbol.iterator]()
  export const rx = /a+/g
  export const lone = { "\\uD800": 7 }
  export const nil = null
  export const num = 5
  export const prim = { [Symbol.toPrimitive](hint) { log.push(hint); return 3 } }
  export const custom = { toString() { return "custom" } }
  export const loose = { valueOf() { log.push("valueOf"); return 1 } }
  export function poke(host) { const o = {}; host(o); return o.seen }
  export function pokeSelf(host) { const o = {}; o.self = o; host(o); return 1 }
  export const identity = (v) => v
  export const readP = (v) => v.p.a
  export const typed = new Int16Array([1, -2])
  export const clamped = new Uint8ClampedArray([1, 2])
`

async function setup(options: RuntimeOptions = {}) {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  const module = await engine.compile("values-api.js", fixture)
  const rt = await engine.newRuntime(options)
  await rt.load(module)
  const v = (name: string) => rt.getValue(name)
  return { engine, rt, module, v }
}

it("reads with symbol, number, receiver and ill-formed keys", async () => {
  const { rt, v } = await setup()
  const obj = await v("obj")
  const sym = (await (await v("sym")).export()) as symbol
  expect(await (await obj.get(sym)).export()).toBe(1)
  expect(await (await obj.get(2)).export()).toBe("two")
  expect(await (await obj.get("2")).export()).toBe("two")
  expect(await (await obj.get("who", { receiver: { tag: "r" } })).export()).toBe("r")
  expect((await obj.lookup("missing")).found).toBe(false)
  const proxied = await (await v("proxy")).lookup("x")
  expect([proxied.found, await proxied.value.export()]).toEqual([true, 9])
  expect(await obj.getMethod("missing")).toBeUndefined()
  await expect(obj.getMethod("who")).rejects.toMatchObject({ kind: "exception", name: "TypeError" })
  expect(await (await (await v("lone")).get("\uD800")).export()).toBe(7)
  expect(await (await rt.getProperty(obj, sym)).export()).toBe(1)
}, 40_000)

it("writes, defines and deletes like engine Object methods", async () => {
  const { rt, v } = await setup()
  const fresh = await rt.newObject()
  expect(await fresh.set("a", 1)).toBe(true)
  const frozen = await v("frozen")
  expect(await frozen.set("a", 2)).toBe(false)
  await expect(frozen.setProp("a", 2)).rejects.toMatchObject({ name: "TypeError" })
  await expect((await rt.fromHost("text")).setV("x", 1)).rejects.toMatchObject({
    name: "TypeError"
  })
  const sealed = await rt.newObject()
  await sealed.preventExtensions()
  expect(await sealed.createDataProperty("x", 1)).toBe(false)
  await expect(sealed.createDataPropertyOrThrow("x", 1)).rejects.toThrow("Cannot define property")
  expect(await fresh.defineOwnProperty("k", { value: 1 })).toBe(true)
  const desc = await fresh.getOwnProperty("k")
  expect(await desc!.value!.export()).toBe(1)
  expect([desc!.writable, desc!.enumerable, desc!.configurable]).toEqual([false, false, false])
  await fresh.definePropertyOrThrow("g", { get: rt.function("g", 0, () => 5), configurable: true })
  expect(await (await fresh.get("g")).export()).toBe(5)
  const accessor = await fresh.getOwnProperty("g")
  expect("set" in accessor! && accessor!.set === undefined && !("value" in accessor!)).toBe(true)
  await expect(fresh.defineOwnProperty("m", { value: 1, get: () => 1 })).rejects.toMatchObject({
    kind: "bridge"
  })
  expect(await fresh.delete("k")).toBe(false)
  const proxy = await v("proxy")
  const log = await v("log")
  expect(await proxy.delete("x")).toBe(true)
  expect(await log.export()).not.toContain("deleteProperty")
  await proxy.deletePropertyOrThrow("x")
  expect(await log.export()).toContain("deleteProperty")
}, 40_000)

it("queries keys with and without traps", async () => {
  const { rt, v } = await setup()
  const s = Symbol("k")
  const keyed = await rt.fromHost({ b: 1, 1: 1, a: 1, [s]: 1 })
  const own = await keyed.ownPropertyKeys()
  expect(own.slice(0, 3)).toEqual(["1", "b", "a"])
  expect(typeof own[3]).toBe("symbol")
  const proxy = await v("proxy")
  expect(await proxy.ownKeys()).toEqual(["x"])
  expect(await proxy.ownPropertyKeys()).toEqual([])
  expect(await proxy.ownEnumerableStringKeys()).toEqual([])
  expect(await proxy.hasOwn("x")).toBe(true)
  expect(await (await v("log")).export()).toContain("gopd")
  const sym = (await (await v("sym")).export()) as symbol
  expect(await (await v("obj")).has(sym)).toBe(true)
  expect(await proxy.hasProperty("x")).toBe(false)
  await expect((await rt.fromHost(1)).has("x")).rejects.toMatchObject({ name: "TypeError" })
  const patched = await setup({ mutableIntrinsics: true })
  await patched.rt.evalScript("p.js", "Reflect.has = () => true; undefined")
  expect(await (await patched.rt.newObject()).has("missing")).toBe(false)
  expect(await (await v("obj")).enumerableOwnKeys()).toEqual(["2", "tag", "who"])
}, 40_000)

it("reads and sets prototypes and integrity levels", async () => {
  const { rt, v } = await setup()
  const proxy = await v("proxy")
  expect(await proxy.proto()).toBeNull()
  expect(await rt.sameValue(await proxy.prototypeOf(), await rt.intrinsic("ArrayPrototype"))).toBe(
    true
  )
  const o = await rt.newObject()
  expect(await o.setPrototypeOf(null)).toBe(true)
  expect(await o.proto()).toBeNull()
  const child = await rt.newObjectWithProto(o)
  expect(await o.setPrototypeOf(child)).toBe(false)
  expect(await (await rt.intrinsic("ObjectPrototype"))!.setPrototypeOf(o)).toBe(false)
  await o.freeze()
  expect([await o.isFrozen(), await o.isSealed(), await o.isExtensible()]).toEqual([
    true,
    true,
    false
  ])
  const sealed = await rt.newObject()
  await sealed.seal()
  expect([await sealed.isSealed(), await sealed.isExtensible()]).toEqual([true, false])
}, 40_000)

it("introspects without running code, also while interrupted", async () => {
  const { rt, v, engine } = await setup()
  const proxy = await v("proxy")
  expect(proxy.kind).toBe("Object")
  expect(await proxy.class()).toBe("Proxy")
  expect(await (await v("iter")).class()).toBe("ArrayIterator")
  const revocable = await v("revocable")
  const revocableProxy = await revocable.get("proxy")
  expect(await revocableProxy.isRevokedProxy()).toBe(false)
  await (await revocable.get("revoke")).call(undefined)
  expect(await revocableProxy.isRevokedProxy()).toBe(true)
  const dep = await engine.compile("dep.js", "export const d = 1")
  const entry = await engine.compile(
    "entry.js",
    'import * as dep from "dep"\nexport const ns = dep'
  )
  const linked = await engine.link(entry, () => dep)
  const other = await engine.newRuntime()
  await other.load(linked)
  expect(await (await other.getValue("ns")).isModuleNamespace()).toBe(true)
  expect(await (await v("wrapper")).primitiveValue()).toEqual({ value: 5, ok: true })
  expect(await (await v("callableProxy")).isCallable()).toBe(true)
  expect(await (await v("arrow")).isConstructor()).toBe(false)
  expect(await (await v("A")).isConstructor()).toBe(true)
  const nil = await v("nil")
  expect([nil.type, nil.kind]).toEqual(["null", "object"])
  const num = await v("num")
  expect([num.id, num.type]).toEqual([0, "number"])
  expect(await rt.callFunction(await v("identity"), undefined, num)).toBe(5)
  expect(await (await v("callableProxy")).typeOf()).toBe("function")
  expect(await (await rt.fromHost("q")).displayString()).toContain('"q"')
  expect(await (await v("arrow")).toBoolean()).toBe(true)
  const frozen = await v("frozen")
  rt.interrupt("x")
  expect(await frozen.isFrozen()).toBe(true)
  expect(await proxy.class()).toBe("Proxy")
  expect(await frozen.getOwnProperty("a")).toMatchObject({ writable: false })
  await expect(frozen.get("a")).rejects.toMatchObject({ kind: "interrupted" })
  await rt.clearInterrupt()
}, 40_000)

it("constructs with optional newTarget and creates objects, arrays and regexps", async () => {
  const { rt, v } = await setup()
  const A = await v("A")
  const B = await v("B")
  const made = await rt.construct(A, [], B)
  expect(await (await made.get("nt")).export()).toBe("B")
  expect(await rt.instanceOf(made, B)).toBe(true)
  expect(await (await (await A.construct()).get("nt")).export()).toBe("A")
  await expect((await v("arrow")).construct()).rejects.toThrow("is not a constructor")
  await expect(A.construct([], (await rt.fromHost(1)) as Value)).rejects.toMatchObject({
    kind: "bridge"
  })
  expect(await (await rt.newObjectWithProto(null)).proto()).toBeNull()
  const holes = await rt.newArrayLen(3)
  expect(await holes.arrayLength()).toBe(3)
  expect(await holes.getOwnProperty(0)).toBeUndefined()
  expect(await holes.push(1)).toBe(true)
  expect(await holes.setLength(1)).toBe(true)
  const frozenArray = await rt.newArray(1)
  await frozenArray.freeze()
  expect(await frozenArray.push(2)).toBe(false)
  expect(await (await rt.newArray(1, { a: 1 })).export()).toEqual([1, { a: 1 }])
  expect(await (await (await rt.newRegExp("a+", "g")).regExpExec("caat"))!.export()).toEqual(["aa"])
  await expect(rt.newRegExp("(", "")).rejects.toMatchObject({ name: "SyntaxError" })
  expect(await (await v("rx")).regExpData()).toEqual({ source: "a+", flags: "g" })
  const patched = await setup({ mutableIntrinsics: true })
  await patched.rt.evalScript(
    "rx.js",
    'Object.defineProperty(RegExp.prototype, "source", { get() { return "spoof" } }); Object.defineProperty(RegExp.prototype, "flags", { get() { return "x" } }); undefined'
  )
  expect(((await (await patched.v("rx")).export()) as RegExp).source).toBe("a+")
  expect(await (await rt.evalScriptValue("pa.js", "new Proxy([], {})")).isArray()).toBe(true)
  const revoked = await rt.evalScriptValue(
    "rv.js",
    "(() => { const r = Proxy.revocable([], {}); r.revoke(); return r.proxy })()"
  )
  await expect(revoked.isArray()).rejects.toMatchObject({ name: "TypeError" })
}, 40_000)

it("detaches and copies buffers and typed elements", async () => {
  const { rt, v } = await setup()
  const buffer = await rt.newArrayBuffer(new Uint8Array([1, 2, 3]))
  expect(await buffer.bufferData()).toEqual(new Uint8Array([1, 2, 3]))
  await rt.detachArrayBuffer(buffer)
  expect(await buffer.isDetachedBuffer()).toBe(true)
  expect((await buffer.bufferData())?.length ?? 0).toBe(0)
  expect(await (await v("typed")).typedArrayElements()).toEqual(new Int16Array([1, -2]))
  expect(await (await v("clamped")).typedArrayElements()).toBeInstanceOf(Uint8Array)
  await expect(
    rt.detachArrayBuffer(await rt.evalScriptValue("sab.js", "new SharedArrayBuffer(1)"))
  ).rejects.toMatchObject({ name: "TypeError" })
}, 40_000)

it("runs abstract conversions with upstream errors", async () => {
  const { rt, v } = await setup()
  await (await v("prim")).toPrimitive("string")
  expect(await (await v("log")).export()).toContain("string")
  expect(await (await rt.fromHost(" 12 ")).toNumber()).toBe(12)
  await expect((await v("sym")).toNumber()).rejects.toThrow(
    "Cannot convert a Symbol value to a number"
  )
  expect(await (await rt.fromHost(10n)).toNumeric()).toBe(10n)
  expect(await (await v("custom")).toJSString()).toBe("custom")
  expect((await (await v("num")).toObject()).kind).toBe("Number")
  await expect((await rt.fromHost(-1)).toIndex()).rejects.toMatchObject({ name: "RangeError" })
  expect(await (await rt.fromHost(2 ** 60)).toLength()).toBe(2 ** 53 - 1)
  expect(await (await rt.fromHost(2 ** 32 + 5)).toInt32()).toBe(5)
  expect(await (await rt.fromHost(-1)).toUint32()).toBe(4294967295)
  expect(await (await rt.fromHost("0x10")).toBigInt()).toBe(16n)
  await expect((await rt.fromHost(1)).toBigInt()).rejects.toMatchObject({ name: "TypeError" })
  expect(await (await rt.fromHost(2n ** 64n - 1n)).toBigInt64()).toBe(-1n)
  expect(await (await rt.fromHost(-1n)).toBigUint64()).toBe(2n ** 64n - 1n)
  expect(await rt.stringToBigInt(" 42 ")).toBe(42n)
  expect(await rt.stringToBigInt("x")).toBeUndefined()
  expect(await (await rt.fromHost(1.5)).toPropertyKey()).toBe("1.5")
  expect(await (await rt.fromHost(0n)).toBoolean()).toBe(false)
}, 40_000)

it("compares and adds with operator semantics", async () => {
  const { rt, v } = await setup()
  expect(await rt.sameValue(NaN, NaN)).toBe(true)
  expect(await rt.strictEquals(NaN, NaN)).toBe(false)
  expect(await rt.sameValueZero(0, -0)).toBe(true)
  expect(await rt.looseEquals("1", 1)).toBe(true)
  expect(await rt.looseEquals(await v("loose"), 1)).toBe(true)
  expect(await (await v("log")).export()).toContain("valueOf")
  expect(await rt.lessThan("a", "b")).toBe(true)
  expect(await rt.isLessThan(NaN, 1)).toBeUndefined()
  expect(await rt.add("a", 1)).toBe("a1")
  expect(await rt.add(1n, 2n)).toBe(3n)
  await expect(rt.add(1n, 1)).rejects.toMatchObject({ name: "TypeError" })
  await expect(rt.instanceOf(await rt.newObject(), await rt.newObject())).rejects.toThrow(
    "Right-hand side of 'instanceof' is not callable"
  )
  const hasInstance = await rt.evalScriptValue("hi.js", "({ [Symbol.hasInstance]: () => true })")
  expect(await rt.instanceOf(1, hasInstance)).toBe(true)
}, 40_000)

it("steps engine iterators by internal state", async () => {
  const { v } = await setup()
  const iter = await v("iter")
  const first = await iter.iteratorNext()
  expect([await first.value.export(), first.done]).toEqual([1, false])
  expect(await (await iter.iteratorNext()).value.export()).toBe(2)
  expect((await iter.iteratorNext()).done).toBe(true)
  expect(await iter.iteratorData()).toMatchObject({ kind: "values", done: true })
  expect(await (await (await v("siter")).iteratorNext()).value.export()).toBe("a")
  await expect((await v("obj")).iteratorNext()).rejects.toMatchObject({ kind: "bridge" })
  const patched = await setup({ mutableIntrinsics: true })
  await patched.rt.evalScript(
    "next.js",
    "Object.getPrototypeOf([][Symbol.iterator]()).next = () => ({ value: 99, done: false }); undefined"
  )
  expect(await (await (await patched.v("iter")).iteratorNext()).value.export()).toBe(1)
}, 40_000)

it("reads the global object and intrinsics", async () => {
  const { rt } = await setup({ mutableIntrinsics: true })
  expect(
    await rt.sameValue(await rt.global(), await rt.evalScriptValue("g.js", "globalThis"))
  ).toBe(true)
  await rt.evalScript("o.js", "globalThis.Object = null; undefined")
  expect(await (await (await rt.intrinsic("ObjectCtor"))!.get("name")).export()).toBe("Object")
  const names: IntrinsicName[] = [
    "ObjectPrototype",
    "FunctionPrototype",
    "ArrayPrototype",
    "BigIntPrototype",
    "JSON",
    "Math",
    "SymbolCtor",
    "MapIteratorPrototype",
    "WeakRefCtor",
    "AggregateErrorCtor",
    "RegExpStringIteratorPrototype"
  ]
  for (const name of names) {
    const value = await rt.intrinsic(name)
    expect(value === null || value instanceof Value).toBe(true)
  }
  await expect(rt.intrinsic("Nope" as IntrinsicName)).rejects.toThrow("unknown intrinsic Nope")
}, 40_000)

it("converts host values through FromGo and passes raw JSON lazily", async () => {
  const { rt, v } = await setup()
  expect(await (await rt.fromGo({ b: 1, a: 2 })).ownPropertyKeys()).toEqual(["a", "b"])
  expect(await (await rt.fromHost({ b: 1, a: 2 })).ownPropertyKeys()).toEqual(["b", "a"])
  await expect(rt.fromGo(2n ** (2n ** 21n))).rejects.toThrow("Maximum BigInt size exceeded")
  expect((await rt.fromGo(new Uint8Array([1]))).kind).toBe("ArrayBuffer")
  const date = (await (await rt.fromGo(new Date(0))).export()) as string
  expect(new Date(date).getTime()).toBe(0)
  const held = await rt.newObject()
  expect(await rt.sameValue(await (await rt.fromGo({ v: held })).get("v"), held)).toBe(true)
  const handle = await rt.newDecodeTarget(nativeTypes.map("string", "int"), { x: 1 })
  await rt.setGlobal("cfg", handle)
  expect(await rt.evalScript("cfg.js", "cfg.x")).toBe(1)
  expect(await (await rt.fromHost({ inner: handle })).export()).toEqual({ inner: { x: 1 } })
  const readP = await v("readP")
  expect(
    await rt.callFunction(readP, undefined, await rt.fromGo({ p: new RawMessage('{"a":1}') }))
  ).toBe(1)
  const bad = await rt.fromGo({ p: new RawMessage("{bad") })
  await expect(rt.callFunction(readP, undefined, bad)).rejects.toMatchObject({
    name: "SyntaxError"
  })
  await expect(rt.fromGo(new RawMessage("{bad"))).rejects.toMatchObject({ name: "SyntaxError" })
  const unread = await rt.fromGo({ payload: new RawMessage('{"a":1}') })
  const back = (await unread.toGo()) as { payload: RawMessage }
  expect(back.payload).toBeInstanceOf(RawMessage)
  expect(back.payload.text).toBe('{"a":1}')
  expect(await (await rt.fromHost({ p: new RawMessage("[1,2]") })).export()).toEqual({ p: [1, 2] })
}, 40_000)

it("gives rt.function live, call-scoped arguments", async () => {
  const { rt, v } = await setup()
  let captured: Value | undefined
  const touch = rt.function("touch", 1, async (o) => {
    captured = o as Value
    await captured.set("seen", true)
  })
  expect(await rt.callFunction(await v("poke"), undefined, touch)).toBe(true)
  await expect(captured!.export()).rejects.toThrow(/released/)
  const held = await rt.newObject()
  const keep = rt.function("keep", 1, () => {})
  await rt.callFunction(await v("identity"), undefined, held)
  await rt.callFunction(await rt.fromHost(keep), undefined, held)
  expect(await held.export()).toEqual({})
  let same: Value | undefined
  let argument: Value | undefined
  const reach = rt.function("reach", 1, async (o) => {
    argument = o as Value
    same = await argument.get("self")
  })
  await rt.callFunction(await v("pokeSelf"), undefined, reach)
  expect(await same!.export()).toBeTypeOf("object")
  await expect(argument!.export()).rejects.toThrow(/released/)
  class E extends Error {}
  const thrown = new E("host")
  const fail = rt.function("fail", 0, () => {
    throw thrown
  })
  const rejection = (await rt
    .callFunction(await v("poke"), undefined, fail)
    .catch((error: unknown) => error)) as { cause?: unknown }
  expect(rejection.cause).toBe(thrown)
}, 40_000)
