package checks

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// A JSON Schema validator for the subset the corpus's schemas use: draft
// 2020-12 keywords, no remote references, no format vocabulary.
//
// Keywords: type (a name or a list; "integer" is a whole number), enum,
// const, required, properties, additionalProperties (false or a schema),
// patternProperties, propertyNames, items (one schema), minItems,
// maxItems, uniqueItems, minLength, maxLength, pattern, minimum, maximum,
// exclusiveMinimum, exclusiveMaximum, multipleOf, allOf, anyOf, oneOf,
// not, if/then/else, and $ref to a local JSON pointer (#/$defs/name).
// Annotation keywords and anything unknown are ignored.

// schemaError is one place a document breaks its schema: path a JSON
// pointer into the document ("" for the root).
type schemaError struct {
	Path, Message string
}

// schemaFault is a schema this validator cannot apply.
type schemaFault struct{ msg string }

func (f schemaFault) Error() string { return f.msg }

// validate is doc's errors against schema; a schema that cannot be
// applied (a remote $ref, a pattern that does not compile) is an error.
func validate(doc, schema any) (errs []schemaError, err error) {
	defer func() {
		if r := recover(); r != nil {
			f, ok := r.(schemaFault)
			if !ok {
				panic(r)
			}
			errs, err = nil, f
		}
	}()
	return validateAt(doc, schema, schema), nil
}

func validateAt(doc, schema, root any) []schemaError {
	v := &validator{root: root}
	v.walk(doc, schema, "")
	return v.errs
}

type validator struct {
	root any
	errs []schemaError
}

func (v *validator) add(path, format string, a ...any) {
	v.errs = append(v.errs, schemaError{Path: path, Message: fmt.Sprintf(format, a...)})
}

func typeOf(x any) string {
	switch x.(type) {
	case nil:
		return "null"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	}
	return "undefined"
}

func hasType(x any, name string) bool {
	if name == "integer" {
		f, ok := x.(float64)
		return ok && f == math.Trunc(f) && !math.IsInf(f, 0)
	}
	return typeOf(x) == name
}

func canonical(x any) string {
	b, _ := json.Marshal(x) // map keys marshal sorted
	return string(b)
}

func deepEqual(a, b any) bool { return canonical(a) == canonical(b) }

func show(x any) string {
	s := canonical(x)
	if utf8.RuneCountInString(s) > 60 {
		return clip(s, 57) + "…"
	}
	return s
}

func compile(pattern any) *regexp.Regexp {
	p, _ := pattern.(string)
	re, err := regexp.Compile(p)
	if err != nil {
		panic(schemaFault{fmt.Sprintf("Invalid regular expression: /%s/: %v", p, err)})
	}
	return re
}

func (v *validator) resolveRef(ref any) any {
	s, ok := ref.(string)
	if !ok || !strings.HasPrefix(s, "#") {
		panic(schemaFault{fmt.Sprintf("$ref %s is not a local JSON pointer — only \"#/…\" references are supported", canonical(ref))})
	}
	node := v.root
	for _, raw := range strings.Split(s[1:], "/") {
		if raw == "" {
			continue
		}
		key := strings.ReplaceAll(strings.ReplaceAll(raw, "~1", "/"), "~0", "~")
		m, ok := node.(map[string]any)
		if !ok {
			if arr, isArr := node.([]any); isArr {
				var i int
				if _, err := fmt.Sscanf(key, "%d", &i); err == nil && fmt.Sprint(i) == key && i >= 0 && i < len(arr) {
					node = arr[i]
					continue
				}
			}
			panic(schemaFault{fmt.Sprintf("$ref %s points at nothing in the schema", canonical(ref))})
		}
		next, has := m[key]
		if !has {
			panic(schemaFault{fmt.Sprintf("$ref %s points at nothing in the schema", canonical(ref))})
		}
		node = next
	}
	return node
}

func num(x any) (float64, bool) {
	f, ok := x.(float64)
	return f, ok
}

func fmtNum(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}

func (v *validator) walk(value, schema any, path string) {
	if schema == nil || schema == true {
		return
	}
	if schema == false {
		v.add(path, "no value is allowed here")
		return
	}
	s, ok := schema.(map[string]any)
	if !ok {
		return
	}
	if ref, has := s["$ref"]; has {
		v.walk(value, v.resolveRef(ref), path)
	}
	if t, has := s["type"]; has {
		var names []string
		if list, isList := t.([]any); isList {
			for _, n := range list {
				names = append(names, fmt.Sprint(n))
			}
		} else {
			names = []string{fmt.Sprint(t)}
		}
		match := false
		for _, n := range names {
			match = match || hasType(value, n)
		}
		if !match {
			v.add(path, "expected %s, got %s %s", strings.Join(names, " or "), typeOf(value), show(value))
			return
		}
	}
	if e, has := s["enum"].([]any); has {
		found := false
		for _, x := range e {
			found = found || deepEqual(x, value)
		}
		if !found {
			shown := make([]string, len(e))
			for i, x := range e {
				shown[i] = show(x)
			}
			v.add(path, "%s is not one of %s", show(value), strings.Join(shown, ", "))
		}
	}
	if c, has := s["const"]; has && !deepEqual(c, value) {
		v.add(path, "%s is not the required %s", show(value), show(c))
	}
	if str, isStr := value.(string); isStr {
		n := float64(utf8.RuneCountInString(str))
		if m, ok := num(s["minLength"]); ok && n < m {
			v.add(path, "shorter than %s characters", fmtNum(m))
		}
		if m, ok := num(s["maxLength"]); ok && n > m {
			v.add(path, "longer than %s characters", fmtNum(m))
		}
		if p, has := s["pattern"]; has && !compile(p).MatchString(str) {
			v.add(path, "%s does not match /%v/", show(value), p)
		}
	}
	if f, isNum := value.(float64); isNum {
		if m, ok := num(s["minimum"]); ok && f < m {
			v.add(path, "%s is below the minimum %s", fmtNum(f), fmtNum(m))
		}
		if m, ok := num(s["maximum"]); ok && f > m {
			v.add(path, "%s is above the maximum %s", fmtNum(f), fmtNum(m))
		}
		if m, ok := num(s["exclusiveMinimum"]); ok && f <= m {
			v.add(path, "%s is not above %s", fmtNum(f), fmtNum(m))
		}
		if m, ok := num(s["exclusiveMaximum"]); ok && f >= m {
			v.add(path, "%s is not below %s", fmtNum(f), fmtNum(m))
		}
		if m, ok := num(s["multipleOf"]); ok && math.Abs(f/m-math.Round(f/m)) > 1e-9 {
			v.add(path, "%s is not a multiple of %s", fmtNum(f), fmtNum(m))
		}
	}
	if arr, isArr := value.([]any); isArr {
		n := float64(len(arr))
		if m, ok := num(s["minItems"]); ok && n < m {
			v.add(path, "fewer than %s items", fmtNum(m))
		}
		if m, ok := num(s["maxItems"]); ok && n > m {
			v.add(path, "more than %s items", fmtNum(m))
		}
		if u, _ := s["uniqueItems"].(bool); u {
			seen := map[string]bool{}
			for _, x := range arr {
				seen[canonical(x)] = true
			}
			if len(seen) != len(arr) {
				v.add(path, "items are not unique")
			}
		}
		if items, has := s["items"]; has {
			for i, x := range arr {
				v.walk(x, items, fmt.Sprintf("%s/%d", path, i))
			}
		}
	}
	if obj, isObj := value.(map[string]any); isObj {
		if req, ok := s["required"].([]any); ok {
			for _, k := range req {
				if _, has := obj[fmt.Sprint(k)]; !has {
					v.add(path, "missing the required property %q", fmt.Sprint(k))
				}
			}
		}
		props, _ := s["properties"].(map[string]any)
		patterns, _ := s["patternProperties"].(map[string]any)
		keys := make([]string, 0, len(obj))
		for k := range obj {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		patternKeys := make([]string, 0, len(patterns))
		for k := range patterns {
			patternKeys = append(patternKeys, k)
		}
		sort.Strings(patternKeys)
		for _, key := range keys {
			child := path + "/" + strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
			matched := false
			if sub, has := props[key]; has {
				matched = true
				v.walk(obj[key], sub, child)
			}
			for _, re := range patternKeys {
				if compile(re).MatchString(key) {
					matched = true
					v.walk(obj[key], patterns[re], child)
				}
			}
			if pn, has := s["propertyNames"]; has {
				v.walk(key, pn, child)
			}
			if ap, has := s["additionalProperties"]; has && !matched {
				if ap == false {
					v.add(path, "the property %q is not allowed", key)
				} else {
					v.walk(obj[key], ap, child)
				}
			}
		}
	}
	passes := func(sub any) bool { return len(validateAt(value, sub, v.root)) == 0 }
	if all, ok := s["allOf"].([]any); ok {
		for _, sub := range all {
			v.walk(value, sub, path)
		}
	}
	if anyOf, ok := s["anyOf"].([]any); ok {
		found := false
		for _, sub := range anyOf {
			found = found || passes(sub)
		}
		if !found {
			v.add(path, "matches none of the anyOf alternatives")
		}
	}
	if oneOf, ok := s["oneOf"].([]any); ok {
		n := 0
		for _, sub := range oneOf {
			if passes(sub) {
				n++
			}
		}
		if n != 1 {
			v.add(path, "must match exactly one of the oneOf alternatives")
		}
	}
	if not, has := s["not"]; has && passes(not) {
		v.add(path, "matches a schema it must not")
	}
	if cond, has := s["if"]; has {
		if passes(cond) {
			v.walk(value, s["then"], path)
		} else {
			v.walk(value, s["else"], path)
		}
	}
}
