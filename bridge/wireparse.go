//go:build js && wasm

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"encoding/json/jsontext"
	"maps"
	"math"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

func (w *wireValue) UnmarshalJSON(data []byte) error {
	p := wireParser{data: data}
	p.space()
	if p.literal("null") {
		return nil
	}
	if p.next() != '{' {
		return wireError("invalid tagged wire value")
	}
	value, err := p.object()
	if err != nil {
		return err
	}
	*w = value
	return nil
}

var errWireSyntax = wireError("invalid wire JSON")

// https://graphics.stanford.edu/~seander/bithacks.html#ZeroInWord
const (
	lowBits     = 0x0101010101010101
	highBits    = 0x8080808080808080
	quotes      = lowBits * '"'
	backslashes = lowBits * '\\'
)

func hasZeroByte(w uint64) uint64 { return (w - lowBits) &^ w & highBits }

// hasByteBelow requires n <= 128.
func hasByteBelow(w uint64, n uint64) uint64 { return (w - lowBits*n) &^ w & highBits }

type wireParser struct {
	data []byte
	pos  int
}

func (p *wireParser) space() {
	for p.pos < len(p.data) {
		switch p.data[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *wireParser) next() byte {
	if p.pos >= len(p.data) {
		return 0
	}
	return p.data[p.pos]
}

func (p *wireParser) literal(text string) bool {
	if len(p.data)-p.pos >= len(text) && string(p.data[p.pos:p.pos+len(text)]) == text {
		p.pos += len(text)
		return true
	}
	return false
}

func (p *wireParser) value() (any, error) {
	p.space()
	switch p.next() {
	case '{':
		return p.object()
	case '[':
		return p.array()
	case '"':
		return p.string()
	case 't':
		if p.literal("true") {
			return true, nil
		}
	case 'f':
		if p.literal("false") {
			return false, nil
		}
	case 'n':
		if p.literal("null") {
			return nil, nil
		}
	default:
		return p.number()
	}
	return nil, errWireSyntax
}

func (p *wireParser) members(each func(key string) error) error {
	if p.next() != '{' {
		return errWireSyntax
	}
	p.pos++
	p.space()
	if p.next() == '}' {
		p.pos++
		return nil
	}
	for {
		p.space()
		key, err := p.key()
		if err != nil {
			return err
		}
		p.space()
		if p.next() != ':' {
			return errWireSyntax
		}
		p.pos++
		p.space()
		if err := each(key); err != nil {
			return err
		}
		p.space()
		switch p.next() {
		case ',':
			p.pos++
		case '}':
			p.pos++
			return nil
		default:
			return errWireSyntax
		}
	}
}

func (p *wireParser) elements(each func() error) error {
	if p.next() != '[' {
		return errWireSyntax
	}
	p.pos++
	p.space()
	if p.next() == ']' {
		p.pos++
		return nil
	}
	for {
		p.space()
		if err := each(); err != nil {
			return err
		}
		p.space()
		switch p.next() {
		case ',':
			p.pos++
		case ']':
			p.pos++
			return nil
		default:
			return errWireSyntax
		}
	}
}

func (p *wireParser) object() (wireValue, error) {
	var w wireValue
	err := p.members(func(key string) error {
		if key == "t" && p.next() == '"' {
			var err error
			w.T, err = p.tag()
			return err
		}
		return p.field(&w, key)
	})
	if w.T == "function" && w.ID > 0 && bindCallback != nil {
		w.V = bindCallback(w.ID)
	}
	return w, err
}

var (
	wireFields    = []string{"t", "v", "id", "kind", "offset", "length", "name", "async", "temporary", "raw", "root"}
	requestFields = []string{"id", "op", "payload"}
)

// Like encoding/json, a key without an exact match matches case-insensitively.
func folded(key string, names []string) (string, bool) {
	for _, name := range names {
		if strings.EqualFold(key, name) {
			return name, true
		}
	}
	return "", false
}

func (p *wireParser) field(w *wireValue, key string) error {
	item, err := p.value()
	if err != nil {
		return err
	}
	return w.set(key, item)
}

func (w *wireValue) set(key string, item any) error {
	switch key {
	case "t":
		w.T, _ = item.(string)
	case "v":
		w.V = item
	case "id":
		n, _ := item.(float64)
		w.ID = int(n)
	case "kind":
		w.Kind, _ = item.(string)
	case "offset":
		n, _ := item.(float64)
		w.Offset = int(n)
	case "length":
		n, _ := item.(float64)
		w.Length = int(n)
	case "name":
		w.Name, _ = item.(string)
	case "async":
		if a, ok := item.(bool); ok {
			w.Async = &a
		}
	case "temporary":
		w.Temporary, _ = item.(bool)
	case "raw":
		w.Raw, _ = item.(bool)
	case "root":
		root, ok := item.(wireValue)
		if !ok {
			return wireError("invalid tagged wire value")
		}
		w.Root = &root
	default:
		if name, ok := folded(key, wireFields); ok {
			return w.set(name, item)
		}
	}
	return nil
}

func (p *wireParser) array() ([]any, error) {
	var items []any
	err := p.elements(func() error {
		item, err := p.value()
		if items == nil {
			items = make([]any, 0, 2)
		}
		items = append(items, item)
		return err
	})
	if items == nil {
		items = []any{}
	}
	return items, err
}

func (p *wireParser) string() (string, error) {
	start := p.pos
	text, plain, err := p.quoted()
	if err != nil || plain {
		return string(text), err
	}
	return p.unquote(start)
}

func (p *wireParser) quoted() (text []byte, plain bool, err error) {
	if p.next() != '"' {
		return nil, false, errWireSyntax
	}
	start := p.pos
	p.pos++
	ascii := true
	for p.pos < len(p.data) {
		for p.pos+8 <= len(p.data) {
			w := binary.LittleEndian.Uint64(p.data[p.pos:])
			if hasZeroByte(w^quotes)|hasZeroByte(w^backslashes)|hasByteBelow(w, 0x20) != 0 {
				break
			}
			if w&highBits != 0 {
				ascii = false
			}
			p.pos += 8
		}
		if p.pos >= len(p.data) {
			break
		}
		switch c := p.data[p.pos]; {
		case c == '"':
			p.pos++
			text := p.data[start+1 : p.pos-1]
			return text, ascii || utf8.Valid(text), nil
		case c == '\\':
			p.skipEscaped()
			p.pos++
			return nil, false, nil
		case c < 0x20:
			return nil, false, errWireSyntax
		case c >= utf8.RuneSelf:
			ascii = false
		}
		p.pos++
	}
	return nil, false, errWireSyntax
}

func (p *wireParser) key() (string, error) {
	start := p.pos
	text, plain, err := p.quoted()
	if err != nil {
		return "", err
	}
	if !plain {
		return p.unquote(start)
	}
	switch string(text) {
	case "t":
		return "t", nil
	case "v":
		return "v", nil
	case "id":
		return "id", nil
	case "kind":
		return "kind", nil
	case "offset":
		return "offset", nil
	case "length":
		return "length", nil
	case "name":
		return "name", nil
	case "async":
		return "async", nil
	case "root":
		return "root", nil
	case "payload":
		return "payload", nil
	case "op":
		return "op", nil
	}
	return string(text), nil
}

func (p *wireParser) tag() (string, error) {
	start := p.pos
	text, plain, err := p.quoted()
	if err != nil {
		return "", err
	}
	if !plain {
		return p.unquote(start)
	}
	switch string(text) {
	case "undefined":
		return "undefined", nil
	case "null":
		return "null", nil
	case "boolean":
		return "boolean", nil
	case "string":
		return "string", nil
	case "string16":
		return "string16", nil
	case "number":
		return "number", nil
	case "bigint":
		return "bigint", nil
	case "symbol":
		return "symbol", nil
	case "native":
		return "native", nil
	case "graph":
		return "graph", nil
	case "node":
		return "node", nil
	case "link":
		return "link", nil
	case "ref":
		return "ref", nil
	case "function":
		return "function", nil
	case "array":
		return "array", nil
	case "object":
		return "object", nil
	case "map":
		return "map", nil
	case "set":
		return "set", nil
	case "date":
		return "date", nil
	case "regexp":
		return "regexp", nil
	case "error":
		return "error", nil
	case "buffer":
		return "buffer", nil
	case "view":
		return "view", nil
	case "rawjson":
		return "rawjson", nil
	}
	return string(text), nil
}

// Like encoding/json, invalid UTF-8 and unpaired surrogates become U+FFFD.
func (p *wireParser) unquote(start int) (string, error) {
	if p.pos > len(p.data) || !wellFormedEscapes(p.data[start+1:p.pos-1]) {
		return "", errWireSyntax
	}
	out, _ := jsontext.AppendUnquote(nil, p.data[start:p.pos])
	return string(out), nil
}

func wellFormedEscapes(text []byte) bool {
	for i := 0; i < len(text); i++ {
		switch c := text[i]; {
		case c < 0x20:
			return false
		case c != '\\':
			continue
		}
		if i++; i == len(text) {
			return false
		}
		switch text[i] {
		case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
		case 'u':
			if i+4 >= len(text) {
				return false
			}
			for _, c := range text[i+1 : i+5] {
				if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F') {
					return false
				}
			}
			i += 4
		default:
			return false
		}
	}
	return true
}

func (p *wireParser) number() (float64, error) {
	start := p.pos
	i := start
	if i < len(p.data) && p.data[i] == '-' {
		i++
	}
	var n uint64
	digits := 0
	for ; i < len(p.data) && p.data[i] >= '0' && p.data[i] <= '9'; i++ {
		n = n*10 + uint64(p.data[i]-'0')
		digits++
	}
	if digits > 0 && digits <= 15 && (i == len(p.data) || (p.data[i] != '.' && p.data[i] != 'e' && p.data[i] != 'E')) {
		p.pos = i
		f := float64(n)
		if p.data[start] == '-' {
			f = -f
		}
		return f, nil
	}
scan:
	for ; i < len(p.data); i++ {
		switch p.data[i] {
		case '+', '-', '.', 'e', 'E', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		default:
			break scan
		}
	}
	f, err := strconv.ParseFloat(string(p.data[start:i]), 64)
	if err != nil || i == start {
		return 0, errWireSyntax
	}
	p.pos = i
	return f, nil
}

func parseRequest(raw string) (*request, error) {
	req := &request{}
	p := wireParser{data: []byte(raw)}
	p.space()
	var field func(key string) error
	field = func(key string) error {
		switch key {
		case "id":
			item, err := p.value()
			n, _ := item.(float64)
			req.ID = int(n)
			return err
		case "op":
			item, err := p.value()
			req.Op, _ = item.(string)
			return err
		case "payload":
			start := p.pos
			if req.Op != "" && req.Op != "moduleResult" {
				req.decoded = true
				if req.payloadErr = req.p.decode(&p); req.payloadErr == nil {
					return nil
				}
				p.pos = start
			}
			if err := p.skip(); err != nil {
				return err
			}
			req.Payload = json.RawMessage(p.data[start:p.pos])
			return nil
		}
		if name, ok := folded(key, requestFields); ok {
			return field(name)
		}
		return p.discard()
	}
	if err := p.members(field); err != nil {
		return req, err
	}
	if p.space(); p.pos != len(p.data) {
		return req, errWireSyntax
	}
	return req, nil
}

func (p *wireParser) skipEscaped() {
	for p.pos < len(p.data) {
		for p.pos+8 <= len(p.data) {
			w := binary.LittleEndian.Uint64(p.data[p.pos:])
			if hasZeroByte(w^quotes)|hasZeroByte(w^backslashes) != 0 {
				break
			}
			p.pos += 8
		}
		if p.pos >= len(p.data) || p.data[p.pos] == '"' {
			return
		}
		if p.data[p.pos] == '\\' {
			p.pos++
		}
		p.pos++
	}
}

func (p *wireParser) skipComposite() bool {
	depth := 0
	for ; p.pos < len(p.data); p.pos++ {
		switch p.data[p.pos] {
		case '"':
			p.pos++
			p.skipEscaped()
		case '{', '[':
			depth++
		case '}', ']':
			depth--
			if depth == 0 {
				p.pos++
				return true
			}
		}
	}
	return false
}

func (out *payload) UnmarshalJSON(data []byte) error {
	p := wireParser{data: data}
	p.space()
	return out.decode(&p)
}

func (out *payload) decode(p *wireParser) error {
	if p.literal("null") {
		return nil
	}
	return p.fields(reflect.ValueOf(out).Elem(), payloadFields)
}

func decodeModuleReply(data []byte, out *moduleReply) error {
	p := wireParser{data: data}
	p.space()
	return p.fields(reflect.ValueOf(out).Elem(), moduleReplyFields)
}

func (p *wireParser) fields(root reflect.Value, table fieldTable) error {
	if p.next() != '{' {
		return wireError("request payload must be an object")
	}
	return p.members(func(key string) error {
		path, ok := table.paths[key]
		if !ok {
			var name string
			if name, ok = folded(key, table.names); ok {
				path = table.paths[name]
			}
		}
		if ok {
			return p.payloadField(root.FieldByIndex(path), key)
		}
		return p.discard()
	})
}

type fieldTable struct {
	paths map[string][]int
	names []string // in field order, which breaks case-insensitive ties
}

var (
	payloadFields      = jsonFieldPaths(reflect.TypeFor[payload]())
	moduleSourceFields = jsonFieldPaths(reflect.TypeFor[moduleSource]())
	moduleReplyFields  = jsonFieldPaths(reflect.TypeFor[moduleReply]())
)

func jsonFieldPaths(t reflect.Type) fieldTable {
	paths := map[string][]int{}
	depths := map[string]int{}
	var walk func(reflect.Type, []int)
	walk = func(t reflect.Type, prefix []int) {
		for i := range t.NumField() {
			f := t.Field(i)
			path := append(slices.Clone(prefix), i)
			tag := f.Tag.Get("json")
			if f.Anonymous && f.Type.Kind() == reflect.Struct && tag == "" {
				walk(f.Type, path)
				continue
			}
			name, _, _ := strings.Cut(tag, ",")
			if !f.IsExported() || name == "-" {
				continue
			}
			if name == "" {
				name = f.Name
			}
			if depth, ok := depths[name]; ok && depth <= len(path) {
				if depth == len(path) {
					delete(paths, name)
				}
				continue
			}
			depths[name] = len(path)
			paths[name] = path
		}
	}
	walk(t, nil)
	names := slices.SortedFunc(maps.Keys(paths), func(a, b string) int { return slices.Compare(paths[a], paths[b]) })
	return fieldTable{paths, names}
}

func (p *wireParser) payloadField(field reflect.Value, key string) error {
	if p.literal("null") {
		switch field.Kind() {
		case reflect.Pointer, reflect.Slice, reflect.Map, reflect.Interface:
			field.SetZero()
		}
		return nil
	}
	switch target := field.Addr().Interface().(type) {
	case *wireValue:
		if p.next() != '{' {
			return wireError("invalid tagged wire value")
		}
		w, err := p.object()
		*target = w
		return err
	case *[]wireValue:
		if p.next() != '[' {
			return fieldError(key)
		}
		values := []wireValue{}
		err := p.elements(func() error {
			if p.next() != '{' {
				return wireError("invalid tagged wire value")
			}
			w, err := p.object()
			values = append(values, w)
			return err
		})
		*target = values
		return err
	case *[]string:
		if p.next() != '[' {
			return fieldError(key)
		}
		values := []string{}
		err := p.elements(func() error {
			if p.next() != '"' {
				return fieldError(key)
			}
			s, err := p.string()
			values = append(values, s)
			return err
		})
		*target = values
		return err
	case **payload:
		if p.next() != '{' {
			return fieldError(key)
		}
		*target = new(payload)
		return p.fields(reflect.ValueOf(*target).Elem(), payloadFields)
	case *[]moduleSource:
		if p.next() != '[' {
			return fieldError(key)
		}
		modules := []moduleSource{}
		err := p.elements(func() error {
			var module moduleSource
			err := p.fields(reflect.ValueOf(&module).Elem(), moduleSourceFields)
			modules = append(modules, module)
			return err
		})
		*target = modules
		return err
	case *map[string]int:
		if p.next() != '{' {
			return fieldError(key)
		}
		values := map[string]int{}
		err := p.members(func(name string) error {
			n, err := p.integer(key)
			values[name] = int(n)
			return err
		})
		*target = values
		return err
	case *string:
		if p.next() != '"' {
			return fieldError(key)
		}
		s, err := p.string()
		*target = s
		return err
	case **string:
		if p.next() != '"' {
			return fieldError(key)
		}
		s, err := p.string()
		*target = &s
		return err
	case *bool:
		switch {
		case p.literal("true"):
			*target = true
		case p.literal("false"):
			*target = false
		default:
			return fieldError(key)
		}
		return nil
	case *int:
		n, err := p.integer(key)
		*target = int(n)
		return err
	case *int64:
		n, err := p.integer(key)
		*target = n
		return err
	}
	start := p.pos
	if err := p.skip(); err != nil {
		return err
	}
	return json.Unmarshal(p.data[start:p.pos], field.Addr().Interface())
}

func fieldError(key string) error { return wireError("invalid request field " + key) }

func (p *wireParser) integer(key string) (int64, error) {
	start := p.pos
	if c := p.next(); c != '-' && (c < '0' || c > '9') {
		return 0, fieldError(key)
	}
	n, err := p.number()
	if err != nil {
		return 0, err
	}
	if text := p.data[start:p.pos]; !bytes.ContainsAny(text, ".eE") {
		exact, err := strconv.ParseInt(string(text), 10, 64)
		if err != nil {
			return 0, fieldError(key)
		}
		return exact, nil
	}
	if n != math.Trunc(n) || n >= math.MaxInt64 || n < math.MinInt64 {
		return 0, fieldError(key)
	}
	return int64(n), nil
}

// discard skips an unknown field, which encoding/json would still validate.
func (p *wireParser) discard() error {
	start := p.pos
	if err := p.skip(); err != nil {
		return err
	}
	if c := p.data[start]; (c == '{' || c == '[') && !json.Valid(p.data[start:p.pos]) {
		return errWireSyntax
	}
	return nil
}

func (p *wireParser) skip() error {
	if c := p.next(); c == '{' || c == '[' {
		if !p.skipComposite() {
			return errWireSyntax
		}
		return nil
	}
	_, err := p.value()
	return err
}
