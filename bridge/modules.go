//go:build js && wasm

package main

import (
	"encoding/json"
	"reflect"
	"sync"

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
	Held        bool           `json:"held"`
	Resolutions map[string]int `json:"resolutions"`
}
type modulePayload struct {
	Modules         []moduleSource `json:"modules"`
	LinkID          int            `json:"linkId"`
	Importer        bool           `json:"importer"`
	ImporterResolve bool           `json:"importerResolve"`
	ImporterMeta    bool           `json:"importerMeta"`
}
type moduleInfo struct {
	moduleID int
	early    func() (*bytecode.Function, error)
	native   *moejs.Module
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
	// Graphs of engine.link() results by linkId, and of import()ed modules as Importer.link caches them.
	linkedModules   map[int]*moejs.Module
	importedModules map[int]*moejs.Module
}
type moduleReply struct {
	ID      int                  `json:"id"`
	Module  *payload             `json:"module"`
	Meta    map[string]wireValue `json:"meta"`
	Error   *errorPayload        `json:"error"`
	failure error
}

func moduleFromBytecode(code *bytecode.Function, early func() (*bytecode.Function, error), typeScript bool) *moejs.Module {
	// The build overlay supplies this constructor without exposing upstream internals.
	factory, ok := any((*moejs.Module)(nil)).(interface {
		MoeJSModuleFromBytecode(*bytecode.Function, func() (*bytecode.Function, error), bool) *moejs.Module
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

func (b *bridge) registerModule(mod *compiledModule, p *payload) {
	mod.moduleID = p.ModuleID
	var early func() (*bytecode.Function, error)
	if mod.early != nil {
		early = func() (*bytecode.Function, error) { return mod.early() }
	}
	mod.native = moduleFromBytecode(mod.code, early, p.TypeScript)
	if b.moduleByNative == nil {
		b.moduleByNative = make(map[moejs.Referrer]moduleReferrer)
	}
	b.moduleByNative[mod.native] = moduleReferrer{Kind: "module", ID: p.ModuleID}
}
func (b *bridge) nativeScript(code *bytecode.Function, p *payload) *moejs.Script {
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

// moduleFromPayload returns the payload's compiled entry and the *moejs.Module it stands for.
func (b *bridge) moduleFromPayload(p *payload) (*compiledModule, *moejs.Module, error) {
	mod, err := b.compilePrepared(p)
	if err != nil {
		return nil, nil, err
	}
	if len(p.Modules) == 0 {
		return mod, mod.native, nil
	}
	cache := &b.importedModules
	key := p.ModuleID
	if p.LinkID != 0 {
		cache, key = &b.linkedModules, p.LinkID
	}
	if linked := (*cache)[key]; linked != nil {
		return mod, linked, nil
	}
	graph := make(map[int]map[string]int, len(p.Modules))
	for i := range p.Modules {
		item := &p.Modules[i]
		if _, err := b.compilePrepared(&payload{compilationPayload: item.compilationPayload, ModuleID: item.ModuleID, Name: item.Name, Source: item.Source, TypeScript: item.TypeScript, Held: item.Held}); err != nil {
			return nil, nil, err
		}
		graph[item.ModuleID] = item.Resolutions
	}
	// Each graph links from its own resolutions, so another graph's choice never leaks in.
	linked, err := moejs.Link(mod.native, func(referrer moejs.Referrer, specifier string) (*moejs.Module, error) {
		id, ok := graph[b.moduleByNative[referrer].ID][specifier]
		if dep := b.modules[id]; ok && dep != nil {
			return dep.native, nil
		}
		return nil, wireError("linked graph refers to an unknown module")
	})
	if err != nil {
		return nil, nil, err
	}
	if b.rt != nil && linked != mod.native {
		if *cache == nil {
			*cache = make(map[int]*moejs.Module)
		}
		(*cache)[key] = linked
		if p.LinkID != 0 {
			b.moduleByNative[linked] = moduleReferrer{Kind: "module", ID: p.LinkID}
		}
	}
	return mod, linked, nil
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
	message := map[string]any{"type": "moduleRequest", "id": id, "kind": kind, "referrer": referrer, "specifier": specifier}
	if meta != nil {
		message["meta"] = b.retainValue(engine.ObjectValue(meta))
	}
	depth := b.nestedDepth
	b.syncHostActive.Add(1)
	defer b.syncHostActive.Add(-1)
	b.post(marshal(message))
	b.replayDeferred()
	reply := <-ch
	b.awaitNested(depth)
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
	if decodeModuleReply(raw, &reply) != nil {
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
func (b *bridge) newImporter(p *payload) *moejs.Importer {
	if !p.Importer {
		return nil
	}
	imp := &moejs.Importer{}
	if p.ImporterResolve {
		imp.Resolve = b.importResolve
	}
	if p.ImporterMeta {
		imp.Meta = b.importMeta
	}
	return imp
}

func (b *bridge) importResolve(referrer moejs.Referrer, specifier string) (*moejs.Module, error) {
	ref, err := b.moduleReferrer(referrer)
	if err != nil {
		return nil, err
	}
	reply, err := b.requestModule("resolve", ref, specifier, nil)
	if err != nil || reply.Module == nil {
		return nil, err
	}
	_, m, err := b.moduleFromPayload(reply.Module)
	return m, err
}

func (b *bridge) importMeta(r *moejs.Realm, module *moejs.Module, meta *moejs.Object) error {
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

func (b *bridge) loadModule(p *payload) error {
	_, m, err := b.moduleFromPayload(p)
	if err != nil {
		return err
	}
	return b.rt.Load(m)
}

// payloadHook rebuilds the host's Hook; a module this runtime never saw names nothing, as lookupOwn decides.
func (b *bridge) payloadHook(p *payload) moejs.Hook {
	m := b.linkedModules[p.LinkID]
	if m == nil {
		if mod := b.modules[p.ModuleID]; mod != nil {
			m = mod.native
		}
	}
	if m == nil || len(p.Path) == 0 {
		return moejs.Hook{}
	}
	hook, _ := m.Hook(p.Path[0], p.Path[1:]...)
	return hook
}
func (b *bridge) moduleExport(name string) (moejs.Value, bool) { return b.rt.Export(name) }
