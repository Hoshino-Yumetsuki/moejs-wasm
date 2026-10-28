//go:build js && wasm

package main

import (
	"errors"
	"syscall"
	"syscall/js"
	"time"
)

// initLocalZone gives time.Local the host zone's rules, as initLocal does for $TZ on unix.
func initLocalZone(global js.Value) {
	name := global.Get("__moeTimeZone")
	if name.Type() != js.TypeString {
		return
	}
	// A zone Go does not know keeps js/wasm's fixed offset, which still matches the host's Date.
	if loc, err := loadLocation(name.String()); err == nil {
		time.Local = loc
	}
}

// loadLocation is time.LoadLocation as on a host whose zoneinfo lacks name: js/wasm's fs stub answers ENOSYS.
func loadLocation(name string) (*time.Location, error) {
	loc, err := time.LoadLocation(name)
	if errors.Is(err, syscall.ENOSYS) {
		return nil, errors.New("unknown time zone " + name)
	}
	return loc, err
}
