//go:build js && wasm

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"syscall/js"
	"time"
	_ "time/tzdata"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/bytecode"
	"github.com/Calcium-Ion/moejs/engine"
)

const defaultMaxSteps int64 = 1_000_000

var errExecutionBudget = errors.New("moejs: execution budget exceeded")

func setExecutionBudget(realm *moejs.Realm, steps int64) {
	// The build overlay adds this method without modifying the upstream checkout.
	limiter, ok := any(realm).(interface{ SetExecutionBudget(int64, error) })
	if !ok {
		panic("execution budget support missing: build with scripts/build-wasm.mjs")
	}
	limiter.SetExecutionBudget(steps, errExecutionBudget)
}

type request struct {
	ID      int             `json:"id"`
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}

type payload struct {
	modulePayload
	valuePayload
	compilationPayload
	controlPayload
	networkPayload
	nativePayload
	Reentrant          bool            `json:"reentrant"`
	ModuleID           int             `json:"moduleId"`
	ScriptID           int             `json:"scriptId"`
	Name               string          `json:"name"`
	Source             string          `json:"source"`
	TypeScript         bool            `json:"typeScript"`
	Path               []string        `json:"path"`
	Args               []wireValue     `json:"args"`
	Value              wireValue       `json:"value"`
	CallID             int             `json:"callId"`
	Error              *errorPayload   `json:"error"`
	MemoryLimit        int64           `json:"memoryLimit"`
	MutableIntrinsics  bool            `json:"mutableIntrinsics"`
	DisableDynamicCode bool            `json:"disableDynamicCode"`
	MaxDynamicSource   int             `json:"maxDynamicSource"`
	Locale             string          `json:"locale"`
	TimeZone           string          `json:"timeZone"`
	MaxSteps           *int64          `json:"maxSteps"`
	Network            *networkOptions `json:"network"`
}

type compiledModule struct {
	moduleInfo
	code     *bytecode.Function
	graph    *engine.ModuleGraph
	name     string
	exports  []string
	requests []string
}

type hostCall struct {
	promise moejs.Value
	resolve func(moejs.Value) error
	reject  func(moejs.Value) error
}

type pendingOperation struct {
	id       int
	promise  moejs.Value
	load     bool
	observed *moejs.Object
}

type operationResult struct {
	data     any
	value    moejs.Value
	hasValue bool
	raw      bool
}

type bridge struct {
	loopState
	moduleState
	valueState
	controlState
	networkState
	nativeState
	rt             *moejs.Runtime
	modules        map[int]*compiledModule
	scripts        map[int]*bytecode.Function
	hostCalls      map[int]hostCall
	shutdown       chan struct{}
	nextHostCall   int
	hostFunctions  map[int]moejs.Value
	pending        *pendingOperation
	pendingOps     map[int]*pendingOperation
	hostMu         sync.Mutex
	hostWaiters    map[int]chan payload
	syncHostActive atomic.Int32
	maxSteps       int64
	compileSteps   int64
	fatal          error
}

func main() {
	b := &bridge{modules: make(map[int]*compiledModule), scripts: make(map[int]*bytecode.Function), hostCalls: make(map[int]hostCall), maxSteps: defaultMaxSteps, shutdown: make(chan struct{})}
	dispatch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return nil
		}
		go b.accept(args[0].String())
		return nil
	})
	js.Global().Set("__moeDispatch", dispatch)
	<-b.shutdown
	dispatch.Release()
}

func (b *bridge) respond(id int, value any, err error) {
	if err != nil {
		js.Global().Call("__moeRespond", marshal(map[string]any{"id": id, "ok": false, "error": b.errorPayload(err)}))
	} else {
		js.Global().Call("__moeRespond", marshal(map[string]any{"id": id, "ok": true, "value": value}))
	}
}

func (b *bridge) guard(fn func() error) error       { return b.guardRuntime(fn, true) }
func (b *bridge) guardNative(fn func() error) error { return b.guardRuntime(fn, false) }

func (b *bridge) guardRuntime(fn func() error, jobs bool) (err error) {
	if b.rt == nil {
		return fn()
	}
	r := b.rt.Realm()
	saved := r.CallState()
	defer func() {
		if x := recover(); x != nil {
			r.RestoreCallState(saved)
			err = &moejs.InternalError{Value: x, Stack: debug.Stack()}
			r.DropJobs(err)
		}
	}()
	if !jobs {
		return fn()
	}
	r.HoldJobs()
	err = r.CheckInterrupt()
	if err == nil {
		err = fn()
	}
	return r.ReleaseJobs(err)
}

func (b *bridge) dispatch(raw string) {
	var req request
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		b.respond(0, nil, wireError(err.Error()))
		return
	}
	defer func() {
		if x := recover(); x != nil {
			err := &moejs.InternalError{Value: x, Stack: debug.Stack()}
			b.fatal = err
			b.respond(req.ID, nil, err)
		}
	}()
	if b.closed.Load() {
		b.respond(req.ID, nil, wireError("bridge closed"))
		return
	}
	var p payload
	if err := json.Unmarshal(req.Payload, &p); err != nil {
		b.respond(req.ID, nil, wireError(err.Error()))
		return
	}
	if b.fatal != nil {
		b.respond(req.ID, nil, b.fatal)
		return
	}
	if len(b.pendingOps) != 0 && req.Op != "settle" && !p.Reentrant {
		b.respond(req.ID, nil, wireError("runtime already has an operation pending"))
		return
	}
	// These native operations run no guest code and leave interrupts pending.
	if b.rt != nil {
		switch req.Op {
		case "module":
			if current := b.rt.Module(); current != nil {
				b.respond(req.ID, map[string]any{"moduleId": b.moduleByNative[current].ID}, nil)
			} else {
				b.respond(req.ID, nil, nil)
			}
			return
		case "thrownValue", "stackTrace":
			out, err := b.queryError(req.Op, p)
			b.respond(req.ID, out, err)
			return
		case "stats":
			b.respond(req.ID, b.rt.Stats(), nil)
			return
		case "resetAllocation":
			b.rt.ResetAllocation()
			b.respond(req.ID, nil, nil)
			return
		case "releaseCallData":
			b.rt.ReleaseCallData()
			b.respond(req.ID, nil, nil)
			return
		case "valueRelease":
			_, _, err := b.dispatchValues(req.Op, p)
			b.respond(req.ID, nil, err)
			return
		}
	}
	if req.Op != "settle" && !p.Reentrant {
		b.compileSteps = b.maxSteps
		if p.MaxSteps != nil && b.rt == nil {
			b.compileSteps = *p.MaxSteps
		}
		if b.rt != nil {
			setExecutionBudget(b.rt.Realm(), b.maxSteps)
		}
	}
	var result any
	var value moejs.Value
	var valueResult bool
	rawResult := p.Raw
	var loadPromise *engine.Object
	runGuard := b.guard
	switch req.Op {
	case "load", "call", "has", "runScript":
		runGuard = b.guardNative
	default:
		if strings.HasPrefix(req.Op, "native") {
			runGuard = b.guardNative
		}
	}
	err := runGuard(func() error {
		if b.rt != nil {
			for _, extension := range []func(string, payload) (operationResult, bool, error){b.dispatchNative, b.dispatchValues, b.dispatchControl, b.dispatchNetwork} {
				out, handled, err := extension(req.Op, p)
				if handled {
					result, value, valueResult, rawResult = out.data, out.value, out.hasValue, out.raw
					return err
				}
			}
		}
		switch req.Op {
		case "compile", "link":
			var mod *compiledModule
			var err error
			if req.Op == "link" {
				mod, err = b.prepareModule(p)
			} else {
				mod, err = b.compile(p)
			}
			if err != nil {
				return err
			}
			result, err = moduleMetadata(mod)
			return err
		case "compileScript", "compileFunction":
			p.Function = req.Op == "compileFunction"
			code, err := b.compileScript(p)
			if err != nil {
				return err
			}
			result, err = scriptMetadata(code)
			return err
		case "newRuntime":
			if b.rt != nil {
				return wireError("runtime already initialized")
			}
			steps := defaultMaxSteps
			if p.MaxSteps != nil {
				steps = *p.MaxSteps
			}
			if steps <= 0 {
				return wireError("maxSteps must be a positive integer")
			}
			if p.MemoryLimit < 0 {
				return wireError("memoryLimit must not be negative")
			}
			var zone *time.Location
			if p.TimeZone != "" {
				var err error
				zone, err = time.LoadLocation(p.TimeZone)
				if err != nil {
					return err
				}
			}
			b.maxSteps = steps
			b.rt = moejs.NewRuntime(moejs.Options{MemoryLimit: p.MemoryLimit, MutableIntrinsics: p.MutableIntrinsics, DisableDynamicCode: p.DisableDynamicCode, MaxDynamicSource: p.MaxDynamicSource, Locale: p.Locale, TimeZone: zone})
			b.pendingOps = make(map[int]*pendingOperation)
			b.initializeValues()
			b.installImporter(p)
			if err := b.initializeLoop(p); err != nil {
				return err
			}
			setExecutionBudget(b.rt.Realm(), steps)
			b.rt.AddLiveRoots(func(add func(moejs.Value)) {
				for _, call := range b.hostCalls {
					add(call.promise)
				}
				for _, fn := range b.hostFunctions {
					add(fn)
				}
				for _, pending := range b.pendingOps {
					add(pending.promise)
				}
			})
			b.startLoop()
		default:
			if b.rt == nil {
				return wireError("runtime is not initialized")
			}
			switch req.Op {
			case "load":
				var err error
				loadPromise, err = b.loadModule(p)
				return err
			case "call":
				referrer, known := b.moduleByNative[b.rt.Module()]
				if p.ModuleID != 0 && (!known || referrer.ID != p.ModuleID) {
					return moejs.ErrHookNotFound
				}
				hook, err := b.moduleHook(p.Path)
				if err != nil {
					return err
				}
				args := make([]moejs.Value, len(p.Args))
				for i, item := range p.Args {
					args[i], err = b.decode(item, true, 0)
					if err != nil {
						return err
					}
				}
				value, err = b.rt.Call(hook, args...)
				valueResult = true
				return err
			case "runScript":
				code, err := b.compileScript(p)
				if err != nil {
					return err
				}
				value, err = b.rt.RunScript(b.nativeScript(code, p))
				valueResult = true
				return err
			case "get":
				var err error
				value, err = b.lookup(p.Path, false)
				valueResult = true
				return err
			case "has":
				hook, err := b.moduleHook(p.Path)
				if err != nil {
					return err
				}
				result, err = b.rt.Has(hook)
				return err
			case "export":
				exported, ok := b.moduleExport(p.Name)
				if !ok {
					exported = moejs.Undefined()
				}
				result = map[string]any{"value": b.retainValue(exported), "ok": ok}
			case "evalScript":
				var err error
				value, err = b.rt.Realm().EvalScript(p.Name, p.Source)
				valueResult = true
				return err
			case "setGlobal":
				value, err := b.decode(p.Value, true, 0)
				if err != nil {
					return err
				}
				return b.rt.SetGlobal(p.Name, value)
			case "settle":
				call, ok := b.hostCalls[p.CallID]
				if !ok {
					return nil
				}
				delete(b.hostCalls, p.CallID)
				if p.Error != nil {
					err := b.hostError(p.Error)
					thrown, ok := b.rt.ThrownValue(err)
					if !ok {
						return err
					}
					return call.reject(thrown)
				}
				value, err := b.decode(p.Value, true, 0)
				if err != nil {
					return err
				}
				return call.resolve(value)
			default:
				return wireError("unknown operation: " + req.Op)
			}
		}
		return nil
	})
	if err != nil {
		b.respond(req.ID, nil, err)
		if req.Op == "settle" {
			b.rejectPending(err)
		}
		return
	}
	if req.Op == "load" {
		if loadPromise != nil {
			b.addPending(&pendingOperation{id: req.ID, promise: engine.ObjectValue(loadPromise), load: true})
			b.poll()
			return
		}
	}
	if valueResult {
		if rawResult {
			b.respond(req.ID, b.retainValue(value), nil)
		} else {
			b.addPending(&pendingOperation{id: req.ID, promise: value})
			b.poll()
		}
		return
	}
	b.respond(req.ID, result, nil)
	if req.Op == "settle" {
		b.poll()
	}
}

func (b *bridge) poll() {
	for _, pending := range b.pendingOps {
		b.pollOperation(pending)
	}
}

func (b *bridge) addPending(p *pendingOperation) {
	if b.pendingOps == nil {
		b.pendingOps = make(map[int]*pendingOperation)
	}
	b.pendingOps[p.id] = p
	b.pending = p
}

func (b *bridge) completePending(id int) {
	delete(b.pendingOps, id)
	if b.pending != nil && b.pending.id == id {
		b.pending = nil
		for _, other := range b.pendingOps {
			b.pending = other
			break
		}
	}
}

func (b *bridge) rejectPending(err error) {
	for id := range b.pendingOps {
		b.respond(id, nil, err)
		delete(b.pendingOps, id)
	}
	b.pending = nil
}

func (b *bridge) pollOperation(pending *pendingOperation) {
	if b.pendingOps[pending.id] != pending {
		return
	}
	value := pending.promise
	for {
		state, result, ok := moejs.PromiseResult(value)
		if !ok {
			break
		}
		if state == moejs.PromisePending {
			pending.promise = value
			b.observePending(pending, value)
			return
		}
		if state == moejs.PromiseRejected {
			err := b.rt.Realm().Throw(result)
			b.completePending(pending.id)
			b.respond(pending.id, nil, err)
			return
		}
		value = result
	}
	if pending.load {
		b.completePending(pending.id)
		b.respond(pending.id, nil, nil)
		return
	}
	var encoded wireValue
	err := b.guard(func() error {
		var err error
		encoded, err = b.encode(value, make(map[*moejs.Object]bool), 0)
		return err
	})
	b.completePending(pending.id)
	b.respond(pending.id, encoded, err)
}

func (b *bridge) lookup(path []string, own bool) (moejs.Value, error) {
	if len(path) == 0 || b.rt.Module() == nil {
		return moejs.Undefined(), moejs.ErrHookNotFound
	}
	value, ok := b.moduleExport(path[0])
	if !ok || value.IsHole() {
		return moejs.Undefined(), moejs.ErrHookNotFound
	}
	for _, key := range path[1:] {
		if own {
			if !value.IsObject() {
				return moejs.Undefined(), moejs.ErrHookNotFound
			}
			ok, err := b.rt.Realm().HasOwn(value.AsObject(), b.rt.Realm().KeyFromGoString(key))
			if err != nil {
				return moejs.Undefined(), err
			}
			if !ok {
				return moejs.Undefined(), moejs.ErrHookNotFound
			}
		}
		var err error
		value, err = b.rt.Get(value, key)
		if err != nil {
			return moejs.Undefined(), err
		}
	}
	return value, nil
}

func (b *bridge) stopCompile() error {
	b.compileSteps--
	if b.compileSteps < 0 {
		return errExecutionBudget
	}
	return nil
}

func (b *bridge) compile(p payload) (*compiledModule, error) { return b.compilePrepared(p) }

func (b *bridge) compileScript(p payload) (*bytecode.Function, error) {
	return b.compileScriptPrepared(p)
}

func (b *bridge) hostFunction(callbackID int, options ...hostFunctionOptions) moejs.Value {
	if fn, ok := b.hostFunctions[callbackID]; ok {
		return fn
	}
	opts := hostFunctionOptions{Name: fmt.Sprintf("host%d", callbackID), Async: true}
	if len(options) != 0 {
		opts = options[0]
	}
	fn := b.rt.Function(opts.Name, opts.Length, func(_ *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
		encoded := make([]wireValue, len(args))
		for i, arg := range args {
			var err error
			encoded[i], err = b.encode(arg, make(map[*moejs.Object]bool), 0)
			if err != nil {
				return moejs.Undefined(), err
			}
		}
		thisWire, err := b.encode(this, make(map[*moejs.Object]bool), 0)
		if err != nil {
			return moejs.Undefined(), err
		}
		if !opts.Async {
			reply, err := b.callHost(callbackID, encoded, thisWire)
			if err != nil {
				return moejs.Undefined(), err
			}
			return b.decode(reply, true, 0)
		}
		b.nextHostCall++
		id := b.nextHostCall
		promise, resolve, reject := b.rt.NewPromise()
		b.hostCalls[id] = hostCall{promise: promise, resolve: resolve, reject: reject}
		js.Global().Call("__moeHostCall", marshal(map[string]any{"id": id, "callbackId": callbackID, "args": encoded, "thisValue": thisWire}))
		return promise, nil
	})
	if b.hostFunctions == nil {
		b.hostFunctions = make(map[int]moejs.Value)
	}
	b.hostFunctions[callbackID] = fn
	return fn
}

func (b *bridge) hostError(p *errorPayload) error {
	switch p.Kind {
	case "interrupted", "budget", "memory", "timeout", "internal":
		return b.payloadNativeError(p)
	}
	if p.Value != nil {
		value, err := b.decode(*p.Value, true, 0)
		if err != nil {
			return err
		}
		return b.rt.Realm().Throw(value)
	}
	value, _ := b.rt.ThrownValue(&hostPayloadError{*p})
	if value.IsObject() && p.Name != "" {
		r := b.rt.Realm()
		if err := value.AsObject().CreateDataPropertyOrThrow(r, r.KeyFromGoString("name"), moejs.String(p.Name)); err != nil {
			return err
		}
	}
	return b.rt.Realm().Throw(value)
}

func (b *bridge) acceptHostSettlement(raw json.RawMessage) bool {
	var p payload
	if json.Unmarshal(raw, &p) != nil {
		return false
	}
	b.hostMu.Lock()
	ch := b.hostWaiters[p.CallID]
	delete(b.hostWaiters, p.CallID)
	b.hostMu.Unlock()
	if ch == nil {
		return false
	}
	ch <- p
	return true
}

func (b *bridge) closeHostCalls() {
	b.hostMu.Lock()
	defer b.hostMu.Unlock()
	for id, ch := range b.hostWaiters {
		ch <- payload{Error: &errorPayload{Kind: "closed", Name: "Error", Message: "MoeJS runtime is closed"}}
		delete(b.hostWaiters, id)
	}
}

func (b *bridge) acceptNested(raw string, req request) bool {
	if b.syncHostActive.Load() == 0 {
		return false
	}
	var p payload
	if json.Unmarshal(req.Payload, &p) != nil || !p.Reentrant {
		return false
	}
	switch req.Op {
	case "close", "moduleResult", "settle", "interrupt", "clearInterrupt", "loopStart", "loopRun", "loopStop", "loopStopNoWait", "loopTerminate":
		return false
	case "loopHold", "loopRelease", "loopPost", "loopRunOnLoop", "promiseResolve", "promiseReject", "networkClose", "networkSetContext", "networkCancelContext", "networkCancelParent":
		return b.acceptControl(req)
	}
	b.dispatch(raw)
	return true
}
