//go:build js && wasm

package main

import (
	"encoding/json"
	"encoding/json/jsontext"
	"maps"
	"math"
	"slices"
	"strconv"
)

func appendJSON(buf []byte, v any) []byte {
	switch x := v.(type) {
	case nil:
		return append(buf, "null"...)
	case rawJSON:
		return append(buf, x...)
	case base64Text:
		return append(append(append(buf, '"'), x...), '"')
	case wireValue:
		return x.appendJSON(buf)
	case *wireValue:
		if x == nil {
			return append(buf, "null"...)
		}
		return x.appendJSON(buf)
	case []wireValue:
		return appendList(buf, x, func(buf []byte, w *wireValue) []byte { return w.appendJSON(buf) })
	case [2]wireValue:
		buf = append(buf, '[')
		buf = x[0].appendJSON(buf)
		buf = append(buf, ',')
		buf = x[1].appendJSON(buf)
		return append(buf, ']')
	case []wireEntry:
		buf = append(buf, '[')
		for i := range x {
			if i != 0 {
				buf = append(buf, ',')
			}
			buf = append(appendJSON(append(buf, '['), x[i].Key), ',')
			buf = append(x[i].Value.appendJSON(buf), ']')
		}
		return append(buf, ']')
	case []any:
		return appendList(buf, x, func(buf []byte, item *any) []byte { return appendJSON(buf, *item) })
	case []string:
		return appendList(buf, x, func(buf []byte, item *string) []byte { return appendString(buf, *item) })
	case []int:
		return appendList(buf, x, func(buf []byte, item *int) []byte { return strconv.AppendInt(buf, int64(*item), 10) })
	case map[string]any:
		if x == nil {
			return append(buf, "null"...)
		}
		buf = append(buf, '{')
		for i, key := range slices.Sorted(maps.Keys(x)) {
			if i != 0 {
				buf = append(buf, ',')
			}
			buf = appendString(buf, key)
			buf = append(buf, ':')
			buf = appendJSON(buf, x[key])
		}
		return append(buf, '}')
	case string:
		return appendString(buf, x)
	case bool:
		return strconv.AppendBool(buf, x)
	case int:
		return strconv.AppendInt(buf, int64(x), 10)
	case int64:
		return strconv.AppendInt(buf, x, 10)
	case float64:
		if !math.IsNaN(x) && !math.IsInf(x, 0) {
			return appendFloat(buf, x)
		}
	}
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return append(buf, data...)
}

func appendList[T any](buf []byte, items []T, appendItem func([]byte, *T) []byte) []byte {
	if items == nil {
		return append(buf, "null"...)
	}
	buf = append(buf, '[')
	for i := range items {
		if i != 0 {
			buf = append(buf, ',')
		}
		buf = appendItem(buf, &items[i])
	}
	return append(buf, ']')
}

type rawJSON []byte

type base64Text string

func appendString(buf []byte, s string) []byte {
	buf, _ = jsontext.AppendQuote(buf, s)
	return buf
}

// Like JavaScript: exponents only outside [1e-6, 1e21), without a leading zero.
func appendFloat(buf []byte, f float64) []byte {
	format := byte('f')
	if abs := math.Abs(f); abs != 0 && (abs < 1e-6 || abs >= 1e21) {
		format = 'e'
	}
	buf = strconv.AppendFloat(buf, f, format, -1, 64)
	if format == 'e' {
		if n := len(buf); n >= 4 && buf[n-4] == 'e' && buf[n-3] == '-' && buf[n-2] == '0' {
			buf[n-2] = buf[n-1]
			buf = buf[:n-1]
		}
	}
	return buf
}

func (w *wireValue) appendJSON(buf []byte) []byte {
	buf = append(buf, `{"t":`...)
	buf = appendString(buf, w.T)
	if w.V != nil && w.T != "function" {
		buf = append(buf, `,"v":`...)
		buf = appendJSON(buf, w.V)
	}
	if w.ID != 0 || w.T == "node" {
		buf = append(buf, `,"id":`...)
		buf = strconv.AppendInt(buf, int64(w.ID), 10)
	}
	if w.Kind != "" {
		buf = append(buf, `,"kind":`...)
		buf = appendString(buf, w.Kind)
	}
	if w.T == "view" {
		buf = append(buf, `,"offset":`...)
		buf = strconv.AppendInt(buf, int64(w.Offset), 10)
		buf = append(buf, `,"length":`...)
		buf = strconv.AppendInt(buf, int64(w.Length), 10)
	}
	if w.Name != "" {
		buf = append(buf, `,"name":`...)
		buf = appendString(buf, w.Name)
	}
	if w.Async != nil {
		buf = append(buf, `,"async":`...)
		buf = strconv.AppendBool(buf, *w.Async)
	}
	if w.Temporary {
		buf = append(buf, `,"temporary":true`...)
	}
	if w.Raw {
		buf = append(buf, `,"raw":true`...)
	}
	if w.Root != nil {
		buf = append(buf, `,"root":`...)
		buf = w.Root.appendJSON(buf)
	}
	return append(buf, '}')
}

func (w wireValue) MarshalJSON() ([]byte, error) { return w.appendJSON(nil), nil }
