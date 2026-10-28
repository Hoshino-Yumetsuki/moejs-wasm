//go:build js && wasm

package main

import (
	"encoding/json"
	"errors"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall/js"
	"time"
	_ "time/tzdata"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/bytecode"
)

const defaultMaxSteps int64 = 1_000_000

var errExecutionBudget = errors.New("moejs: execution budget exceeded")

// realmBudget is what scripts/build-wasm.mjs adds to engine.Realm.
type realmBudget interface {
	SetExecutionBudget(steps int64, exhausted error)
	RefillExecutionBudget()
	BeginHolding() bool
	EndHolding(began bool)
}

func budgetOf(realm *moejs.Realm) realmBudget {
	budget, ok := any(realm).(realmBudget)
	if !ok {
		panic("execution budget support missing: build with scripts/build-wasm.mjs")
	}
	return budget
}

func compileBudget(p *payload) int64 {
	if p.MaxSteps != nil {
		if *p.MaxSteps <= 0 {
			return -1
		}
		return *p.MaxSteps
	}
	// Dense generated code uses about one compile checkpoint per 25 bytes.
	return max(defaultMaxSteps, int64(len(p.Source)+len(p.Params)+len(p.Body))/8)
}

type request struct {
	ID         int
	Op         string
	Payload    json.RawMessage
	p          payload
	payloadErr error
	decoded    bool
	nested     bool
}

type payload struct {
	modulePayload
	valuePayload
	compilationPayload
	controlPayload
	networkPayload
	nativePayload
	Reentrant          bool            `json:"reentrant"`
	Held               bool            `json:"held"`
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
	TimeZone           *string         `json:"timeZone"`
	MaxSteps           *int64          `json:"maxSteps"`
	Network            *networkOptions `json:"network"`
	WebAPI             *bool           `json:"webAPI"`
	GCPercent          *int            `json:"gcPercent"`
	GoMemoryLimit      *int64          `json:"goMemoryLimit"`
}

type compiledModule struct {
	moduleInfo
	code     *bytecode.Function
	name     string
	exports  []string
	requests []string
}

type hostCall struct {
	promise moejs.Value
	resolve func(moejs.Value) error
	reject  func(moejs.Value) error
	release func(func(*moejs.Runtime))
	temps   []int
}

type pendingOperation struct {
	id       int
	promise  moejs.Value
	observed *moejs.Object
}

type operationResult struct {
	data     any
	value    moejs.Value
	hasValue bool
	raw      bool
}

type jsCallbacks struct {
	message, networkAllow, network js.Value
}

var host jsCallbacks

type bridge struct {
	loopState
	moduleState
	valueState
	controlState
	networkState
	nativeState
	releaseState
	preemptState
	rt             *moejs.Runtime
	modules        map[int]*compiledModule
	scripts        map[int]*bytecode.Function
	hostCalls      map[int]hostCall
	shutdown       chan struct{}
	idle           chan string
	nextHostCall   int
	pendingOps     map[int]*pendingOperation
	hostMu         sync.Mutex
	hostWaiters    map[int]chan *payload
	syncHostActive atomic.Int32
	budget         realmBudget
	compileSteps   int64
	compileUntil   time.Time
	compileMs      float64
	compileTicks   uint32
	held           []int
}

func main() {
	global := js.Global()
	initLocalZone(global)
	host = jsCallbacks{global.Get("__moeMessage"), global.Get("__moeNetworkAllow"), global.Get("__moeNetwork")}
	b := &bridge{modules: make(map[int]*compiledModule), scripts: make(map[int]*bytecode.Function), hostCalls: make(map[int]hostCall), shutdown: make(chan struct{}), idle: make(chan string)}
	dispatch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return nil
		}
		raw := args[0].String()
		select {
		case b.idle <- raw:
		default:
			go b.serve(raw)
		}
		return nil
	})
	bindCallback = b.bindCallback
	js.Global().Set("__moeDispatch", dispatch)
	<-b.shutdown
	dispatch.Release()
}

// A sync host callback parks its goroutine, so dispatch starts another when none is idle.
func (b *bridge) serve(raw string) {
	for {
		b.accept(raw)
		raw = <-b.idle
	}
}

func (b *bridge) respond(id int, value any, err error) {
	if id < 0 {
		return
	}
	buf := strconv.AppendInt(append(make([]byte, 0, 64), `{"type":"response","id":`...), int64(id), 10)
	if err != nil {
		buf = appendJSON(append(buf, `,"ok":false,"error":`...), b.errorPayload(err))
	} else {
		buf = appendJSON(append(buf, `,"ok":true,"value":`...), value)
	}
	b.post(string(append(buf, '}')))
}

func (b *bridge) post(message string) {
	if b.held != nil {
		ids := b.held
		b.held = nil
		host.message.Invoke(marshal(map[string]any{"type": "event", "kind": "held", "ids": ids}))
	}
	b.releaseMu.Lock()
	released := b.releasedCallbacks
	b.releasedCallbacks = nil
	b.releaseMu.Unlock()
	if released != nil {
		host.message.Invoke(marshal(map[string]any{"type": "event", "kind": "released", "ids": released}))
	}
	host.message.Invoke(message)
}

func (b *bridge) postHostCall(id, callbackID int, args []wireValue, this wireValue) {
	buf := strconv.AppendInt(append(make([]byte, 0, 128), `{"type":"hostCall","id":`...), int64(id), 10)
	buf = strconv.AppendInt(append(buf, `,"callbackId":`...), int64(callbackID), 10)
	buf = appendJSON(append(buf, `,"args":`...), args)
	buf = this.appendJSON(append(buf, `,"thisValue":`...))
	b.post(string(append(buf, '}')))
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

func (b *bridge) dispatch(req *request) {
	defer func() {
		if x := recover(); x != nil {
			b.respond(req.ID, nil, &moejs.InternalError{Value: x, Stack: debug.Stack()})
		}
	}()
	if b.closed.Load() {
		b.respond(req.ID, nil, wireError("bridge closed"))
		return
	}
	if req.payloadErr != nil {
		b.respond(req.ID, nil, wireError(req.payloadErr.Error()))
		return
	}
	p := &req.p
	b.drainSymbols()
	// Released handles are applied in order, even while an operation is pending.
	switch req.Op {
	case "release":
		b.releaseHandles(p)
		return
	case "debugRetention":
		b.respond(req.ID, b.retentionStats(), nil)
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
		case "promiseState":
			out, err := b.promiseState(p)
			b.respond(req.ID, out, err)
			return
		case "runtimeNewPromise":
			promise, resolve, reject := b.rt.NewPromise()
			b.nextRuntimePromise++
			b.runtimePromises[b.nextRuntimePromise] = runtimePromise{resolve, reject}
			b.respond(req.ID, map[string]any{"promiseId": b.nextRuntimePromise, "promise": b.retainValue(promise)}, nil)
			return
		}
	}
	// Each request is its own task; one nested in a sync host call shares the caller's budget.
	if !req.nested {
		if b.budget != nil {
			b.budget.RefillExecutionBudget()
		} else if b.rt == nil {
			b.compileSteps = compileBudget(p)
			b.compileUntil, b.compileMs = time.Time{}, p.DeadlineMs
			if p.DeadlineAt > 0 {
				b.compileUntil = time.UnixMilli(0).Add(time.Duration(p.DeadlineAt * float64(time.Millisecond)))
			}
		}
	}
	var result any
	var value moejs.Value
	var valueResult bool
	rawResult := p.Raw
	runGuard := b.guard
	switch req.Op {
	case "load", "call", "has", "runScript", "setGlobal", "rebaseAllocation", "newPromise", "runtimePromiseResolve", "runtimePromiseReject", "valuePure":
		runGuard = b.guardNative
	default:
		if strings.HasPrefix(req.Op, "native") {
			runGuard = b.guardNative
		}
	}
	err := runGuard(func() error {
		if b.rt != nil {
			for _, extension := range [...]func(*bridge, string, *payload) (operationResult, bool, error){(*bridge).dispatchNative, (*bridge).dispatchValues, (*bridge).dispatchControl, (*bridge).dispatchNetwork} {
				out, handled, err := extension(b, req.Op, p)
				if handled {
					result, value, valueResult, rawResult = out.data, out.value, out.hasValue, out.raw
					return err
				}
			}
		}
		switch req.Op {
		case "compile":
			mod, err := b.compile(p)
			if err != nil {
				return err
			}
			result, err = moduleMetadata(mod, mod.exports, true)
			return err
		case "link":
			mod, linked, err := b.moduleFromPayload(p)
			if err != nil {
				return err
			}
			result, err = moduleMetadata(mod, linked.Exports(), false)
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
			// Omitted is Options.TimeZone nil, time.Local; a string is a name time.LoadLocation takes.
			var zone *time.Location
			if p.TimeZone != nil {
				var err error
				if zone, err = loadLocation(*p.TimeZone); err != nil {
					return err
				}
			}
			// Each runtime is its own Go instance, so these size its collector as GOGC and GOMEMLIMIT would.
			if p.GCPercent != nil {
				debug.SetGCPercent(*p.GCPercent)
			}
			if p.GoMemoryLimit != nil {
				if *p.GoMemoryLimit <= 0 {
					return wireError("goMemoryLimit must be positive")
				}
				debug.SetMemoryLimit(*p.GoMemoryLimit)
			}
			b.rt = moejs.NewRuntime(moejs.Options{MemoryLimit: p.MemoryLimit, MutableIntrinsics: p.MutableIntrinsics, DisableDynamicCode: p.DisableDynamicCode, MaxDynamicSource: p.MaxDynamicSource, Locale: p.Locale, TimeZone: zone, Importer: b.newImporter(p)})
			b.pendingOps = make(map[int]*pendingOperation)
			b.initializeValues()
			b.initializeControl(p)
			if p.LoopOptions == nil || !p.LoopOptions.Disabled {
				if err := b.initializeLoop(p.LoopOptions); err != nil {
					return err
				}
				if p.WebAPI == nil || *p.WebAPI {
					if err := b.installWebAPI(p); err != nil {
						return err
					}
				}
			}
			b.budget = budgetOf(b.rt.Realm())
			b.budget.SetExecutionBudget(steps, errExecutionBudget)
			b.installInterruptPoll()
			b.rt.AddLiveRoots(func(add func(moejs.Value)) {
				for _, call := range b.hostCalls {
					add(call.promise)
				}
				for _, pending := range b.pendingOps {
					add(pending.promise)
				}
			})
			if b.loop != nil {
				b.implicitStart.Store(true)
				b.startLoop()
			}
		default:
			if b.rt == nil {
				return wireError("runtime is not initialized")
			}
			switch req.Op {
			case "load":
				return b.loadModule(p)
			case "call":
				args, err := b.decodeHeld(p.Args)
				if err != nil {
					return err
				}
				value, err = b.rt.Call(b.payloadHook(p), args...)
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
				var err error
				result, err = b.rt.Has(b.payloadHook(p))
				return err
			case "export":
				exported, ok := b.moduleExport(p.Name)
				if !ok {
					exported = moejs.Undefined()
				}
				result = map[string]any{"value": b.retainValue(exported), "ok": ok}
			case "installWebAPI":
				if b.loop == nil {
					return errors.New("webapi: Install needs a loop")
				}
				return b.installWebAPI(p)
			case "evalScript":
				var err error
				value, err = b.rt.Realm().EvalScript(p.Name, p.Source)
				valueResult = true
				return err
			case "setGlobal":
				values, err := b.decodeHeld([]wireValue{p.Value})
				if err != nil {
					return err
				}
				return b.rt.SetGlobal(p.Name, values[0])
			case "settle":
				return b.settleHostCall(p)
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
}

func (b *bridge) completePending(id int) { delete(b.pendingOps, id) }

func (b *bridge) rejectPending(err error) {
	for id := range b.pendingOps {
		b.respond(id, nil, err)
		delete(b.pendingOps, id)
	}
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
	var encoded wireValue
	err := b.guard(func() error {
		var err error
		encoded, err = b.encode(value)
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
	if b.compileTicks++; b.compileTicks&63 == 0 {
		if err := b.compileExpired(); err != nil {
			return err
		}
	}
	switch {
	case b.compileSteps < 0:
		return nil
	case b.compileSteps == 0:
		return errExecutionBudget
	}
	b.compileSteps--
	return nil
}

// compileExpired is the compile deadline of CompileOptions.Context, set from the request timeout.
func (b *bridge) compileExpired() error {
	if !b.compileUntil.IsZero() && !time.Now().Before(b.compileUntil) {
		return &timeoutError{b.compileMs}
	}
	return nil
}

// decodeHeld decodes host values so a measurement waits until JavaScript can reach them.
func (b *bridge) decodeHeld(items []wireValue) ([]moejs.Value, error) {
	defer b.budget.EndHolding(b.budget.BeginHolding())
	values := make([]moejs.Value, len(items))
	for i, item := range items {
		var err error
		if values[i], err = b.decode(item, true, 0); err != nil {
			return nil, err
		}
	}
	return values, nil
}

func (b *bridge) compile(p *payload) (*compiledModule, error) { return b.compilePrepared(p) }

func (b *bridge) compileScript(p *payload) (*bytecode.Function, error) {
	return b.compileScriptPrepared(p)
}

// hostFunction makes a new guest function per crossing, as FromGo of a NativeFunc does; it keeps cb alive.
func (b *bridge) hostFunction(cb *hostCallback, opts hostFunctionOptions) moejs.Value {
	return b.rt.Function(opts.Name, opts.Length, func(_ *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
		encoded := make([]wireValue, len(args))
		var thisWire wireValue
		var temps []int
		if opts.Raw {
			// NativeFunc arguments are live Values that do not outlive the call.
			for i, arg := range args {
				encoded[i] = b.retainArgument(arg, &temps)
			}
			thisWire = b.retainArgument(this, &temps)
		} else {
			for i, arg := range args {
				var err error
				encoded[i], err = b.encode(arg)
				if err != nil {
					return moejs.Undefined(), err
				}
			}
			var err error
			if thisWire, err = b.encode(this); err != nil {
				return moejs.Undefined(), err
			}
		}
		if !opts.Async {
			reply, err := b.callHost(cb.id, encoded, thisWire)
			defer b.releaseTemporaries(temps)
			if err != nil {
				return moejs.Undefined(), err
			}
			return b.decode(reply, true, 0)
		}
		b.nextHostCall++
		id := b.nextHostCall
		promise, resolve, reject := b.rt.NewPromise()
		call := hostCall{promise: promise, resolve: resolve, reject: reject, temps: temps}
		// Upstream's async host results come from Loop.NewPromise, which holds the loop.
		if b.loop != nil {
			call.release = b.loop.Hold()
		}
		b.hostCalls[id] = call
		b.postHostCall(id, cb.id, encoded, thisWire)
		return promise, nil
	})
}

// hostError is the Go error a host throw stands for; the engine turns a plain one into an Error.
func (b *bridge) hostError(p *errorPayload) error {
	if p == nil {
		return b.payloadNativeError(nil)
	}
	pinned := b.pinPayload(*p)
	return b.payloadNativeError(&pinned)
}

// settleHostCall is pending.run of upstream NewPromise: a host error rejects with its thrown value.
func (b *bridge) settleHostCall(p *payload) error {
	call, ok := b.hostCalls[p.CallID]
	if !ok {
		return nil
	}
	delete(b.hostCalls, p.CallID)
	defer b.releaseTemporaries(call.temps)
	if call.release != nil {
		defer call.release(nil)
	}
	var value moejs.Value
	var err error
	if p.Error != nil {
		err = b.hostError(p.Error)
	} else {
		value, err = b.decode(p.Value, true, 0)
	}
	if err != nil {
		reason, ok := b.rt.ThrownValue(err)
		if !ok {
			return err
		}
		return call.reject(reason)
	}
	return call.resolve(value)
}

// releaseHostCallHolds lets the loop go idle once the host can no longer answer outstanding calls.
func (b *bridge) releaseHostCallHolds() {
	for id, call := range b.hostCalls {
		if call.release != nil {
			call.release(nil)
			call.release = nil
			b.hostCalls[id] = call
		}
	}
}

func (b *bridge) acceptHostSettlement(p *payload) bool {
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

func (b *bridge) closeHostCalls(e errorPayload) {
	b.hostMu.Lock()
	defer b.hostMu.Unlock()
	for id, ch := range b.hostWaiters {
		ch <- &payload{Error: &e}
		delete(b.hostWaiters, id)
	}
}

func (b *bridge) acceptNested(req *request) bool {
	if b.syncHostActive.Load() == 0 || req.payloadErr != nil || !req.p.Reentrant {
		return false
	}
	switch req.Op {
	case "close", "moduleResult", "settle", "interrupt", "loopNew", "loopStart", "loopRun", "loopStop", "loopStopNoWait", "loopTerminate":
		return false
	}
	if !b.deferNested(req) {
		b.dispatchNested(req)
		b.replayDeferred()
	}
	return true
}
