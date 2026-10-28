//go:build js && wasm

package main

import "github.com/Calcium-Ion/moejs"

// Error introspection must work even while a recoverable interrupt is pending.
func (b *bridge) queryError(op string, p *payload) (any, error) {
	if op == "stackTrace" {
		if p.Value.T == "" {
			return "", nil
		}
		value, err := b.decode(p.Value, false, 0)
		if err != nil {
			return nil, err
		}
		return b.rt.StackTrace(&moejs.Exception{Value: value}), nil
	}
	err := b.hostError(p.Error)
	value, ok := b.rt.ThrownValue(err)
	return map[string]any{"value": b.retainValue(value), "ok": ok}, nil
}
