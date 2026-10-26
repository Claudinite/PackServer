package checks

import (
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"

	"claudinite.com/checksdk"
)

// A document that points at a schema ("$schema": "<repo-relative path>")
// has declared its own contract, and a rule about the document's shape
// lives in that schema, enforced here for every such document at once. A
// $schema naming a URL is an editor's hint this check cannot fetch and
// does not judge. Inert on a tree whose documents point at no
// repo-relative schema.
var urlScheme = regexp.MustCompile(`(?i)^[a-z]+:`)

func init() {
	checksdk.Register(checksdk.Check{
		ID:    "schema-conformance",
		Tags:  []string{"world"},
		Since: "2026-09-04",
		Doc:   "engine/checks/README.md",
		Why:   "the schema a document points at is its contract, and a document that drifts from it is read by an editor as wrong and by the engine as nothing — so the drift only surfaces when the reader that consumes the document breaks",
		Run:   schemaConformance,
	})
}

func schemaConformance(repo checksdk.Repo) []checksdk.Finding {
	var out []checksdk.Finding
	for _, file := range repo.Files() {
		if !strings.HasSuffix(file, ".json") || strings.HasSuffix(file, ".schema.json") {
			continue
		}
		text, _ := repo.Read(file)
		var doc map[string]any
		if json.Unmarshal([]byte(text), &doc) != nil || doc == nil {
			continue
		}
		ref, ok := doc["$schema"].(string)
		if !ok || urlScheme.MatchString(ref) {
			continue
		}
		schemaPath := path.Join(path.Dir(file), ref)
		schemaText, ok := repo.Read(schemaPath)
		if !ok {
			out = append(out, checksdk.Finding{
				Path: file, Line: lineOf(text, "$schema"),
				Sentence: fmt.Sprintf("points at %s as its schema, which is not in the tree", schemaPath),
				Fix:      "point $schema at the schema file, relative to this document, or drop the field",
			})
			continue
		}
		var schema any
		if err := json.Unmarshal([]byte(schemaText), &schema); err != nil {
			out = append(out, checksdk.Finding{Path: schemaPath, Sentence: fmt.Sprintf("is not valid JSON, so %s cannot be judged against it: %v", file, err), Fix: "fix the schema file"})
			continue
		}
		errs, err := validate(any(doc), schema)
		if err != nil {
			out = append(out, checksdk.Finding{Path: schemaPath, Sentence: fmt.Sprintf("cannot be applied: %v", err), Fix: "fix the schema file"})
			continue
		}
		for _, e := range errs {
			line := 0
			if key := lastSegment(e.Path); key != "" {
				line = lineOf(text, key)
			}
			where := "the document"
			if e.Path != "" {
				where = "at " + e.Path
			}
			out = append(out, checksdk.Finding{
				Path: file, Line: line,
				Sentence: fmt.Sprintf("%s: %s (against %s)", where, e.Message, schemaPath),
				Fix:      "bring the document to the schema's shape, or change the schema when the shape is right — the schema is the contract",
			})
		}
	}
	return out
}

func lastSegment(pointer string) string {
	parts := strings.Split(pointer, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			return parts[i]
		}
	}
	return ""
}

// lineOf is the 1-based line carrying "key", 0 when none: a best-effort
// anchor, since a parsed document has no positions.
func lineOf(text, key string) int {
	needle := `"` + strings.ReplaceAll(strings.ReplaceAll(key, "~1", "/"), "~0", "~") + `"`
	for i, l := range strings.Split(text, "\n") {
		if strings.Contains(l, needle) {
			return i + 1
		}
	}
	return 0
}
