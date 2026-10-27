//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sync"
	"syscall/js"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/bytecode"
	"github.com/Calcium-Ion/moejs/engine"
)

type moduleSource struct {
	compilationPayload
	ModuleID    int            `json:"moduleId"`
	Name        string         `json:"name"`
	Source      string         `json:"source"`
	TypeScript  bool           `json:"typeScript"`
	Resolutions map[string]int `json:"resolutions"`
}
type modulePayload struct {
	Modules      []moduleSource `json:"modules"`
	Importer     bool           `json:"importer"`
	ImporterMeta bool           `json:"importerMeta"`
}
type moduleInfo struct {
	moduleID    int
	resolutions map[string]int
	early       *bytecode.Function
	codeWire    string
	earlyWire   string
	native      *moejs.Module
	linked      *moejs.Module
}
type moduleReferrer struct {
	Kind   string     `json:"kind"`
	ID     int        `json:"id"`
	Native *wireValue `json:"native,omitempty"`
}
type moduleState struct {
	moduleMu          sync.Mutex
	moduleWaiters     map[int]chan moduleReply
	nextModuleRequest int
	modulesClosed     bool
	moduleByNative    map[moejs.Referrer]moduleReferrer
	nativeScripts     map[*bytecode.Function]*moejs.Script
	importerEnabled   bool
}
type moduleReply struct {
	ID      int                  `json:"id"`
	Module  *payload             `json:"module"`
	Meta    map[string]wireValue `json:"meta"`
	Error   *errorPayload        `json:"error"`
	failure error
}

func moduleFromBytecode(code, early *bytecode.Function, typeScript bool) *moejs.Module {
	// The build overlay supplies this constructor without exposing upstream internals.
	factory, ok := any((*moejs.Module)(nil)).(interface {
		MoeJSModuleFromBytecode(*bytecode.Function, *bytecode.Function, bool) *moejs.Module
	})
	if !ok {
		panic("bytecode module support missing: build with scripts/build-wasm.mjs")
	}
	return factory.MoeJSModuleFromBytecode(code, early, typeScript)
}

func scriptFromBytecode(code *bytecode.Function) *moejs.Script {
	// The build overlay supplies this constructor without exposing upstream internals.
	factory, ok := any((*moejs.Script)(nil)).(interface {
		MoeJSScriptFromBytecode(*bytecode.Function) *moejs.Script
	})
	if !ok {
		panic("bytecode script support missing: build with scripts/build-wasm.mjs")
	}
	return factory.MoeJSScriptFromBytecode(code)
}

func linkedModuleGraph(module *moejs.Module) *engine.ModuleGraph {
	linked, ok := any(module).(interface {
		LinkedGraph() *engine.ModuleGraph
	})
	if !ok {
		panic("linked module support missing: build with scripts/build-wasm.mjs")
	}
	return linked.LinkedGraph()
}

func setRuntimeImporter(runtime *moejs.Runtime, importer *moejs.Importer) {
	host, ok := any(runtime).(interface {
		SetImporter(*moejs.Importer)
	})
	if !ok {
		panic("module importer support missing: build with scripts/build-wasm.mjs")
	}
	host.SetImporter(importer)
}

func moduleEvaluationPromise(runtime *moejs.Runtime) *engine.Object {
	evaluation, ok := any(runtime).(interface {
		ModuleEvaluationPromise() *engine.Object
	})
	if !ok {
		panic("module evaluation support missing: build with scripts/build-wasm.mjs")
	}
	return evaluation.ModuleEvaluationPromise()
}

func (b *bridge) registerModule(mod *compiledModule, p payload) {
	mod.moduleID = p.ModuleID
	mod.native = moduleFromBytecode(mod.code, mod.early, p.TypeScript)
	if b.moduleByNative == nil {
		b.moduleByNative = make(map[moejs.Referrer]moduleReferrer)
	}
	b.moduleByNative[mod.native] = moduleReferrer{Kind: "module", ID: p.ModuleID}
}
func (b *bridge) nativeScript(code *bytecode.Function, p payload) *moejs.Script {
	if script := b.nativeScripts[code]; script != nil {
		return script
	}
	script := scriptFromBytecode(code)
	if b.nativeScripts == nil {
		b.nativeScripts = make(map[*bytecode.Function]*moejs.Script)
	}
	if b.moduleByNative == nil {
		b.moduleByNative = make(map[moejs.Referrer]moduleReferrer)
	}
	b.nativeScripts[code] = script
	b.moduleByNative[script] = moduleReferrer{Kind: "script", ID: p.ScriptID}
	return script
}
func (b *bridge) prepareModule(p payload) (*compiledModule, error) {
	mod, err := b.compilePrepared(p)
	if err != nil {
		return nil, err
	}
	// Each compiler Link is independent; runtime module identity is persistent.
	if b.rt == nil {
		for _, cached := range b.modules {
			cached.graph = nil
			cached.linked = nil
			cached.resolutions = nil
		}
	}
	for _, item := range p.Modules {
		if _, err := b.compilePrepared(payload{compilationPayload: item.compilationPayload, ModuleID: item.ModuleID, Name: item.Name, Source: item.Source, TypeScript: item.TypeScript}); err != nil {
			return nil, err
		}
	}
	for _, item := range p.Modules {
		owner := b.modules[item.ModuleID]
		if owner.resolutions == nil {
			owner.resolutions = make(map[string]int)
		}
		for specifier, id := range item.Resolutions {
			if b.modules[id] == nil {
				return nil, wireError("linked graph refers to an unknown module")
			}
			if previous, ok := owner.resolutions[specifier]; ok && previous != id {
				return nil, wireError(fmt.Sprintf("inconsistent resolution of %q in %s", specifier, owner.name))
			}
			owner.resolutions[specifier] = id
		}
	}
	if mod.linked == nil {
		mod.linked, err = moejs.Link(mod.native, b.resolveNative)
		if err != nil {
			return nil, err
		}
		b.moduleByNative[mod.linked] = moduleReferrer{Kind: "module", ID: mod.moduleID}
		mod.graph = linkedModuleGraph(mod.linked)
		mod.exports = mod.linked.Exports()
	}
	return mod, nil
}
func (b *bridge) moduleReferrer(referrer moejs.Referrer) (any, error) {
	if referrer == nil {
		return nil, nil
	}
	if ref, ok := b.moduleByNative[referrer]; ok {
		return ref, nil
	}
	// Native compilation bypasses descriptor registration. Retain the actual Go
	// referrer rather than manufacturing a high-level compiled descriptor.
	wire, err := b.encodeNative(reflect.ValueOf(referrer))
	if err != nil {
		return nil, err
	}
	return moduleReferrer{Kind: "native", ID: wire.ID, Native: &wire}, nil
}
func (b *bridge) resolveNative(referrer moejs.Referrer, specifier string) (*moejs.Module, error) {
	ref, known := b.moduleByNative[referrer]
	if known && ref.Kind == "module" {
		owner := b.modules[ref.ID]
		if id, ok := owner.resolutions[specifier]; ok {
			return b.modules[id].native, nil
		}
	}
	if b.rt == nil || !b.importerEnabled {
		return nil, moejs.ErrNoResolver
	}
	refWire, err := b.moduleReferrer(referrer)
	if err != nil {
		return nil, err
	}
	dependency, err := b.resolveImport(refWire, specifier)
	if err != nil {
		return nil, err
	}
	if known && ref.Kind == "module" {
		owner := b.modules[ref.ID]
		if owner.resolutions == nil {
			owner.resolutions = make(map[string]int)
		}
		owner.resolutions[specifier] = dependency.moduleID
	}
	return dependency.linked, nil
}

func (b *bridge) requestModule(kind string, referrer any, specifier string, meta *engine.Object) (moduleReply, error) {
	b.moduleMu.Lock()
	if b.modulesClosed {
		b.moduleMu.Unlock()
		return moduleReply{}, wireError("runtime closed")
	}
	if b.moduleWaiters == nil {
		b.moduleWaiters = make(map[int]chan moduleReply)
	}
	b.nextModuleRequest++
	id := b.nextModuleRequest
	ch := make(chan moduleReply, 1)
	b.moduleWaiters[id] = ch
	b.moduleMu.Unlock()
	message := map[string]any{"id": id, "kind": kind, "referrer": referrer, "specifier": specifier}
	if meta != nil {
		message["meta"] = b.retainValue(engine.ObjectValue(meta))
	}
	b.syncHostActive.Add(1)
	defer b.syncHostActive.Add(-1)
	js.Global().Call("__moeModuleRequest", marshal(message))
	reply := <-ch
	if reply.failure != nil {
		return reply, reply.failure
	}
	if reply.Error != nil {
		return reply, b.hostModuleError(reply.Error)
	}
	return reply, nil
}
func (b *bridge) acceptModuleResult(raw json.RawMessage) {
	var reply moduleReply
	if json.Unmarshal(raw, &reply) != nil {
		return
	}
	b.moduleMu.Lock()
	ch := b.moduleWaiters[reply.ID]
	delete(b.moduleWaiters, reply.ID)
	b.moduleMu.Unlock()
	if ch != nil {
		ch <- reply
	}
}
func (b *bridge) interruptModules(err error) {
	b.moduleMu.Lock()
	for id, ch := range b.moduleWaiters {
		ch <- moduleReply{failure: err}
		delete(b.moduleWaiters, id)
	}
	b.moduleMu.Unlock()
}
func (b *bridge) closeModules() {
	b.moduleMu.Lock()
	b.modulesClosed = true
	b.moduleMu.Unlock()
	b.interruptModules(wireError("runtime closed"))
}
func (b *bridge) resolveImport(referrer any, specifier string) (*compiledModule, error) {
	reply, err := b.requestModule("resolve", referrer, specifier, nil)
	if err != nil {
		return nil, err
	}
	if reply.Module == nil {
		return nil, wireError("module resolver returned no module")
	}
	return b.prepareModule(*reply.Module)
}
func (b *bridge) installImporter(p payload) {
	b.importerEnabled = p.Importer
	if !p.Importer {
		setRuntimeImporter(b.rt, nil)
		return
	}
	imp := &moejs.Importer{Resolve: b.resolveNative}
	if p.ImporterMeta {
		imp.Meta = func(r *moejs.Realm, module *moejs.Module, meta *moejs.Object) error {
			ref, err := b.moduleReferrer(module)
			if err != nil {
				return err
			}
			reply, err := b.requestModule("meta", ref, "", meta)
			if err != nil {
				return err
			}
			for key, wire := range reply.Meta {
				value, err := b.decode(wire, false, 0)
				if err != nil {
					return err
				}
				if err := meta.CreateDataPropertyOrThrow(r, r.KeyFromGoString(key), value); err != nil {
					return err
				}
			}
			return nil
		}
	}
	setRuntimeImporter(b.rt, imp)
}
func (b *bridge) loadModule(p payload) (*moejs.Object, error) {
	mod, err := b.prepareModule(p)
	if err != nil {
		return nil, err
	}
	err = b.rt.Load(mod.linked)
	if err == moejs.ErrModulePending {
		return moduleEvaluationPromise(b.rt), nil
	}
	return nil, err
}
func (b *bridge) moduleHook(path []string) (moejs.Hook, error) {
	if b.rt.Module() == nil || len(path) == 0 {
		return moejs.Hook{}, moejs.ErrHookNotFound
	}
	return b.rt.Module().Hook(path[0], path[1:]...)
}
func (b *bridge) moduleExport(name string) (moejs.Value, bool) { return b.rt.Export(name) }
