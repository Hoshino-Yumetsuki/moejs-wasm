import { afterEach, describe, expect, it } from "vitest"
import { createMoeJS, NativeHandle, nativeTypes, type Engine } from "moejs-wasm"

const engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})
async function setup() {
  const engine = await createMoeJS({ timeoutMs: 20_000 })
  engines.push(engine)
  const runtime = await engine.newRuntime({ memoryLimit: 20_000_000 })
  return { engine, runtime, root: await runtime.native(), realm: await runtime.realm() }
}

describe("runtime-owned Go reflection handles", () => {
  it("preserves shared and cyclic native FromGo input graphs", async () => {
    const { runtime, root } = await setup()
    const shared = [7]
    const object: { a: typeof shared; b: typeof shared; self?: unknown; arrays?: unknown } = {
      a: shared,
      b: shared
    }
    const array: unknown[] = [shared, shared]
    array.push(array, object)
    object.self = object
    object.arrays = array
    const converted = await root.invoke<NativeHandle>("FromGo", object)
    await runtime.setGlobal("nativeGraph", await converted.asValue())
    expect(
      await runtime.evalScript(
        "native-input-graph.js",
        `
      nativeGraph.a[0] === 7 && nativeGraph.b[0] === 7 && nativeGraph.self.a[0] === 7 &&
      nativeGraph.arrays[0][0] === 7 && nativeGraph.arrays[1][0] === 7 &&
      nativeGraph.arrays[2][0][0] === 7 && nativeGraph.arrays[3].a[0] === 7
    `
      )
    ).toBe(true)
    const convertedArray = await root.invoke<NativeHandle>("FromGo", array)
    await runtime.setGlobal("nativeArray", await convertedArray.asValue())
    expect(
      await runtime.evalScript(
        "native-input-array.js",
        `
      nativeArray[0][0] === 7 && nativeArray[1][0] === 7 && nativeArray[2][0][0] === 7 &&
      nativeArray[3].arrays[0][0] === 7
    `
      )
    ).toBe(true)
    // Upstream FromGo creates lazy guest containers per path; ToGo retains the Go graph.
    const output = await root.invoke<unknown[]>("ToGo", convertedArray)
    expect(output[0]).toBe(output[1])
    expect(output[2]).toBe(output)
  }, 40_000)

  it("keeps native and guest handles distinct from input graph nodes", async () => {
    const engine = await createMoeJS({ timeoutMs: 20_000 })
    engines.push(engine)
    const runtime = await engine.newRuntime()
    const root = await runtime.native()
    const number = await root.invoke<NativeHandle>("FromGo", 7)
    const converted = await root.invoke<NativeHandle>("FromGo", { native: number })
    await runtime.setGlobal("mixed", await converted.asValue())
    expect(await runtime.evalScript("native-mixed.js", "mixed.native === 7")).toBe(true)
    const first = await runtime.fromHost({ answer: 21 })
    const second = await runtime.fromHost({ answer: 42 })
    const realm = await runtime.realm()
    const array = await realm.invoke<NativeHandle>("NewArray", { marker: 7 }, first, second)
    expect(await (await array.asValue()).export()).toEqual([
      { marker: 7 },
      { answer: 21 },
      { answer: 42 }
    ])
  }, 40_000)

  it("shares input identity across native arguments and guest Value children", async () => {
    const { runtime } = await setup()
    const engine = await runtime.native("engine")
    const shared = { marker: 9 }
    expect(await engine.invoke("SameValue", shared, shared)).toBe(true)
    expect(await engine.invoke("SameValue", shared, { marker: 9 })).toBe(false)
    const array = await (await runtime.realm()).invoke<NativeHandle>("NewArray", shared, shared)
    const guest = await array.asValue()
    await runtime.setGlobal("nativeValues", guest)
    expect(
      await runtime.evalScript("native-values.js", "nativeValues[0] === nativeValues[1]")
    ).toBe(true)
  }, 40_000)

  it("returns cyclic and repeated native ToGo arrays as host arrays", async () => {
    const { runtime, root } = await setup()
    await runtime.evalScript(
      "native-output-graph.js",
      `
      globalThis.cyclicArray = [];
      cyclicArray.push(cyclicArray);
      globalThis.repeatedArrays = [cyclicArray, cyclicArray];
    `
    )
    const self = await runtime.evalScriptValue("native-self.js", "cyclicArray")
    const cyclic = await root.invoke<unknown[]>("ToGo", self)
    expect(Array.isArray(cyclic)).toBe(true)
    expect(cyclic[0]).toBe(cyclic)
    const repeated = await runtime.evalScriptValue("native-repeated.js", "repeatedArrays")
    const output = await root.invoke<unknown[][]>("ToGo", repeated)
    expect(output[0]).toBe(output[1])
    expect(output[0][0]).toBe(output[0])
  }, 40_000)

  it("adapts bigint and UTF16 scalars with upstream Go string semantics", async () => {
    const { runtime } = await setup()
    const engine = await runtime.native("engine")
    const integer = 123456789012345678901234567890n
    const [bigint, ok] = await engine.invoke<[NativeHandle, boolean]>("NewBigIntFromBig", integer)
    expect(ok).toBe(true)
    expect(await (await bigint.asValue()).export()).toBe(integer)
    const units = [0x61, 0xd800, 0x62, 0xdc00, 0xd83d, 0xde00]
    const text = await engine.invoke<NativeHandle>("FromUTF16", units)
    expect(await text.invoke("UTF16")).toEqual(units)
    expect(await (await text.asValue()).export()).toBe(String.fromCharCode(...units))
    const fromGo = await engine.invoke<NativeHandle>("FromGoString", String.fromCharCode(...units))
    expect(await fromGo.invoke("UTF16")).toEqual([0x61, 0xfffd, 0x62, 0xfffd, 0xd83d, 0xde00])
  }, 40_000)

  it("calls actual Realm and Object Get/Set methods and preserves descriptor flags", async () => {
    const { runtime, root, realm } = await setup()
    expect(await root.invoke("Realm")).toBe(realm)
    const object = await realm.invoke<NativeHandle>("NewObject")
    expect(object).toBeInstanceOf(NativeHandle)
    await object.invoke("SetProp", realm, "count", 7)
    const guest = await object.asValue()
    const nativeValue = await object.invoke<NativeHandle>("Get", realm, "count", guest)
    expect(await (await nativeValue.asValue()).export()).toBe(7)
    const descriptor = await runtime.newDecodeTarget("PropertyDescriptor", {
      Value: 19,
      Writable: false,
      Enumerable: true,
      Configurable: false
    })
    expect(await descriptor.invoke("HasValue")).toBe(true)
    await object.invoke("DefinePropertyOrThrow", realm, "fixed", descriptor)
    await expect(object.invoke("SetProp", realm, "fixed", 20)).rejects.toThrow()
    expect(await guest.export()).toEqual({ count: 7, fixed: 19 })
    const [own, present] = await object.invoke<[NativeHandle, boolean]>("GetOwnProperty", "fixed")
    expect(present).toBe(true)
    expect(await own.invoke("Writable")).toBe(false)
    expect(await own.invoke("Enumerable")).toBe(true)
    expect(await own.invoke("Configurable")).toBe(false)
  }, 40_000)

  it("constructs native accessor callbacks with []Value arguments and typed error propagation", async () => {
    const { runtime, root, realm } = await setup()
    const object = await realm.invoke<NativeHandle>("NewObject")
    let stored = 11
    const getter = await root.invoke<NativeHandle>("Function", "get value", 0, () => stored)
    const setter = await root.invoke<NativeHandle>(
      "Function",
      "set value",
      1,
      async (_realm: NativeHandle, _this: NativeHandle, args: NativeHandle[]) => {
        stored = (await (await args[0].asValue()).export()) as number
      }
    )
    await object.invoke("DefinePropertyOrThrow", realm, "value", {
      Get: getter,
      Set: setter,
      Enumerable: true,
      Configurable: true
    })
    const value = await object.asValue()
    expect(await (await value.get("value")).export()).toBe(11)
    await object.invoke("SetProp", realm, "value", 38)
    expect(stored).toBe(38)
    expect(await (await value.get("value")).export()).toBe(38)
    await expect(object.invoke("DefinePropertyOrThrow", realm, "bad", { Get: 4 })).rejects.toThrow(
      /Getter|function/i
    )
    await expect(
      object.invoke("DefinePropertyOrThrow", realm, "mixed", { Get: getter, Value: 4 })
    ).rejects.toThrow(/descriptor/i)
    const fail = await root.invoke<NativeHandle>("Function", "fail", 0, () => {
      throw new Error("native callback failure")
    })
    await expect(runtime.callFunction(await fail.asValue(), undefined)).rejects.toThrow(
      /native callback failure/
    )
  }, 40_000)

  it("retains callback values independently of reusable interpreter registers", async () => {
    const { runtime, root } = await setup()
    const captured: NativeHandle[] = []
    const capture = await root.invoke<NativeHandle>(
      "Function",
      "capture",
      1,
      (_realm: NativeHandle, _this: NativeHandle, args: NativeHandle[]) => {
        captured.push(args[0])
      }
    )
    await runtime.setGlobal("capture", await capture.asValue())
    await runtime.evalScript(
      "registers.js",
      "function run(x) { capture(x) }; run(11); run(22); undefined"
    )
    expect(await (await captured[0].asValue()).export()).toBe(11)
    expect(await (await captured[1].asValue()).export()).toBe(22)
    await Promise.all(captured.map((value) => value.release()))
  }, 40_000)

  it("preserves ordinary reportLive data in FromGo and custom codec results", async () => {
    const { runtime, root } = await setup()
    const data = { reportLive: "ordinary data", nested: { reportLive: 42 } }
    const result = await root.invoke<NativeHandle>("FromGo", data)
    expect(await (await result.asValue()).export()).toEqual(data)
    const codec = await runtime.newDecodeTarget("JSONCodec", { Decode: () => data })
    await (await runtime.parseJSONString("null")).unmarshal(codec)
    const output = await codec.invoke<number[]>("MarshalJSON")
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(output)))).toEqual(data)
  }, 40_000)

  it("keeps guest values held only by native environment slots unmeasured unless rooted", async () => {
    const { runtime, realm } = await setup()
    const namespace = await runtime.native("engine")
    const parent = await namespace.invoke<NativeHandle>("NewEnv", null, 1)
    const child = await namespace.invoke<NativeHandle>("NewEnv", parent, 0)
    const before = await realm.invoke<number>("MeasureLive", null)
    const value = await runtime.fromHost("root".repeat(50_000))
    await parent.invoke("SetSlot", 0, value)
    await value.release()
    await parent.release()
    await runtime.releaseCallData()
    // As upstream, MeasureLive counts what guest code and registered roots reach.
    expect((await realm.invoke<number>("MeasureLive", null)) - before).toBeLessThan(200_000)
    const retainedParent = await child.invoke<NativeHandle>("Parent")
    const retained = await retainedParent.invoke<NativeHandle>("Slot", 0)
    const guest = await retained.asValue()
    expect(await guest.export()).toBe("root".repeat(50_000))
    expect((await runtime.measureLive([guest])) - before).toBeGreaterThanOrEqual(200_000)
    await guest.release()
    await retainedParent.invoke("SetSlot", 0, undefined)
    await retained.release()
  }, 40_000)

  it("allocates actual Go structs with JSON tags, slices, maps, pointers and exact integers", async () => {
    const { runtime, root } = await setup()
    const schema = nativeTypes.struct([
      { name: "Count", type: "int16", tag: 'json:"count"' },
      { name: "Name", type: "string", tag: 'json:"name"' },
      { name: "Values", type: nativeTypes.slice("int64"), tag: 'json:"values"' },
      { name: "Lookup", type: nativeTypes.map("string", "uint32"), tag: 'json:"lookup"' },
      { name: "Optional", type: nativeTypes.pointer("int"), tag: 'json:"optional"' },
      { name: "Ignored", type: "bool", tag: 'json:"-"' }
    ])
    const target = await runtime.newDecodeTarget(schema)
    const source = await runtime.parseJSONString(
      '{"count":42,"name":"native","values":[1,-2],"lookup":{"a":8},"optional":5,"Ignored":true}'
    )
    expect(await source.unmarshal(target)).toBe(target)
    expect(await target.read()).toEqual({
      Count: 42,
      Name: "native",
      Values: [1, -2],
      Lookup: { a: 8 },
      Optional: 5,
      Ignored: false
    })
    await target.setField("Count", 29)
    expect(await target.getField("Count")).toBe(29)
    const integer = await runtime.newDecodeTarget("uint64", 18446744073709551615n)
    expect(await integer.read()).toBe(18446744073709551615n)
    await expect(runtime.newDecodeTarget("uint64", -1)).rejects.toThrow(/overflow|integer/i)
    await expect(runtime.newDecodeTarget("int64", 9007199254740992)).rejects.toThrow(/exact|safe/i)
    await expect(target.setField("Count", 40000)).rejects.toThrow(/overflow/)
    await expect(target.setField("missing", 3)).rejects.toThrow(/field/)
    const bad = await runtime.parseJSONString('{"count":"not an integer"}')
    await expect(bad.unmarshal(target)).rejects.toThrow()
    await expect(root.invoke("Unmarshal", source, 9)).rejects.toThrow(/target|pointer/i)
    const second = await runtime.newDecodeTarget(schema)
    expect(await source.toGoInto(second)).toBe(second)
    expect(await second.getField("Count")).toBe(42)
  }, 40_000)

  it("uses generated package namespaces, native byte views, callbacks, and root lifetimes", async () => {
    const { runtime, root, realm } = await setup()
    const engine = await runtime.native("engine")
    const moejs = await runtime.native("moejs")
    const symbol = await engine.invoke<NativeHandle>("NewSymbol", "identity")
    expect((await symbol.asValue()).kind).toMatch(/symbol/i)
    const data = new TextEncoder().encode('xx{"native":true}yy')
    const parsed = await root.invoke<NativeHandle>("ParseJSON", data.subarray(2, data.length - 2))
    expect(await (await parsed.asValue()).export()).toEqual({ native: true })
    const retained = await runtime.fromHost("rooted".repeat(40_000))
    let ephemeral: NativeHandle | undefined
    let calls = 0
    const remove = await root.invoke<NativeHandle>("AddLiveRoots", async (add: NativeHandle) => {
      calls++
      ephemeral = add
      await add.call(retained)
    })
    expect(await realm.invoke<number>("MeasureLive", null)).toBeGreaterThanOrEqual(240_000)
    expect(await retained.toGo()).toBe("rooted".repeat(40_000))
    expect(calls).toBeGreaterThan(0)
    await expect(ephemeral!.call(retained)).rejects.toThrow(/released|unknown/)
    await ephemeral!.release()
    await ephemeral!.release()
    await remove.call()
    const previous = calls
    await realm.invoke("MeasureLive", null)
    expect(calls).toBe(previous)
    const [promise, resolve] =
      await root.invoke<[NativeHandle, NativeHandle, NativeHandle]>("NewPromise")
    await resolve.call(73)
    const [state, result, ok] = await moejs.invoke<[number, NativeHandle, boolean]>(
      "PromiseResult",
      promise
    )
    expect(ok).toBe(true)
    expect(state).toBe(1)
    expect(await (await result.asValue()).export()).toBe(73)
    const foreign = await (await engines[0].newRuntime()).realm()
    expect(() => realm.invoke("NewArray", foreign)).toThrow(/another runtime/)
    await parsed.release()
    await expect(parsed.asValue()).rejects.toThrow(/released/)
  }, 40_000)

  it("adapts the exported Compiler interface and delegates real compiled bytecode", async () => {
    const { runtime, realm } = await setup()
    const engine = await runtime.native("engine")
    const compiler = await engine.getField<NativeHandle>("Compiler")
    const calls: string[] = []
    await engine.invoke("SetCompiler", {
      compileScript: async (name: string, source: string, stop: NativeHandle) => {
        calls.push(name)
        await stop.call()
        return compiler.invoke("CompileScript", name, source, stop)
      },
      compileEval: (name: string, source: string, scope: NativeHandle | null, stop: NativeHandle) =>
        compiler.invoke("CompileEval", name, source, scope, stop),
      compileFunction: (
        name: string,
        params: string,
        body: string,
        generator: boolean,
        async: boolean,
        stop: NativeHandle
      ) => compiler.invoke("CompileFunction", name, params, body, generator, async, stop)
    })
    try {
      const result = await realm.invoke<NativeHandle>("EvalScript", "native-compile.js", "6 * 7")
      expect(await (await result.asValue()).export()).toBe(42)
      expect(calls).toEqual(["native-compile.js"])
    } finally {
      await engine.invoke("SetCompiler", compiler)
    }
  }, 40_000)

  it("runs native JSON and text unmarshal interfaces including nested custom targets", async () => {
    const { runtime } = await setup()
    const codec = await runtime.newDecodeTarget("JSONCodec", {
      Decode: (text: string) => {
        const value: unknown = JSON.parse(text)
        if (!value || typeof value !== "object" || !("n" in value) || typeof value.n !== "number")
          throw new Error("expected numeric n")
        return value.n * 2
      },
      Encode: (value: number) => JSON.stringify({ decoded: value })
    })
    const source = await runtime.parseJSONString('{"n":21}')
    expect(await source.unmarshal(codec)).toBe(codec)
    expect(await codec.getField("Value")).toBe(42)
    const bytes = await codec.invoke<number[]>("MarshalJSON")
    expect(new TextDecoder().decode(Uint8Array.from(bytes))).toBe('{"decoded":42}')
    const nested = await runtime.newDecodeTarget(
      nativeTypes.struct([{ name: "Payload", type: "JSONCodec", tag: 'json:"payload"' }]),
      { Payload: { Decode: (text: string) => JSON.parse(text).n + 1 } }
    )
    await (await runtime.parseJSONString('{"payload":{"n":8}}')).unmarshal(nested)
    expect(await (await nested.getField<NativeHandle>("Payload")).getField("Value")).toBe(9)
    const text = await runtime.newDecodeTarget("TextCodec", {
      Decode: (value: string) => value.toUpperCase(),
      Encode: (value: string) => value.toLowerCase()
    })
    await (await runtime.parseJSONString('"native"')).toGoInto(text)
    expect(await text.getField("Value")).toBe("NATIVE")
    const failed = await runtime.newDecodeTarget("JSONCodec", {
      Decode: () => {
        throw new Error("custom decode rejected")
      }
    })
    await expect(source.unmarshal(failed)).rejects.toThrow(/custom decode rejected/)
    expect(await failed.getField("Value")).toBeNull()
  }, 40_000)

  it("adapts a JavaScript LiveReporter into real Go method-bearing host data", async () => {
    const { root, realm } = await setup()
    const retained = await root.invoke<NativeHandle>("FromGo", "live")
    let reportedBytes = 0
    const functionObject = await realm.invoke<NativeHandle>(
      "NewNativeDataFunction",
      "reporter",
      0,
      async (_realm: NativeHandle, data: NativeHandle) => {
        const host = await data.invoke<NativeHandle>("Data")
        expect(host).toBeInstanceOf(NativeHandle)
        return 1
      },
      {
        reportLive: async (add: NativeHandle, addBytes: NativeHandle) => {
          await add.call(retained)
          await addBytes.call(reportedBytes)
        }
      }
    )
    const rootFunction = await functionObject.asValue()
    const remove = await root.invoke<NativeHandle>("AddLiveRoots", async (add: NativeHandle) => {
      await add.call(rootFunction)
    })
    const baseline = await realm.invoke<number>("MeasureLive", null)
    reportedBytes = 200_000
    const measured = await realm.invoke<number>("MeasureLive", null)
    expect(measured - baseline).toBeGreaterThanOrEqual(200_000)
    await remove.call()
  }, 40_000)

  it("drops the jobs a panicking native operation left queued", async () => {
    const { runtime, root, realm } = await setup()
    await root.invoke("SetPromiseRejectionTracker", () => {
      throw new Error("tracker bug")
    })
    const fn = await runtime.evalScriptValue(
      "queue.js",
      "() => { Promise.resolve().then(() => { Promise.reject(1) }); Promise.resolve().then(() => { globalThis.ran = true }) }"
    )
    await expect(realm.invoke("Call", fn, undefined, [])).rejects.toMatchObject({
      kind: "internal",
      name: "InternalError"
    })
    await root.invoke("SetPromiseRejectionTracker", null)
    await runtime.evalScript("next.js", "0")
    expect(await runtime.evalScript("read.js", "globalThis.ran")).toBeUndefined()
  }, 30_000)
})
