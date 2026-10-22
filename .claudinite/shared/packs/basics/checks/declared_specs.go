package checks

import (
	"encoding/json"
	"regexp"
	"strings"

	"claudinite.com/checksdk"
)

var declaredFile = regexp.MustCompile(`(^|/)declared-checks\.json$`)

// declaredSpec is one declaration of a declared-checks.json: its parsed
// object, its id and the line its id first appears on.
type declaredSpec struct {
	File   string
	ID     string
	Anchor int
	Spec   map[string]any
}

// declaredSpecs are the declarations of every scanned declared-checks.json;
// a file that does not parse, or is not an array, is the loader's finding
// and yields nothing here.
func declaredSpecs(repo checksdk.Repo) []declaredSpec {
	var out []declaredSpec
	for _, file := range repo.Files() {
		if !declaredFile.MatchString(file) {
			continue
		}
		text, ok := repo.Read(file)
		if !ok {
			continue
		}
		var specs []any
		if json.Unmarshal([]byte(text), &specs) != nil {
			continue
		}
		for _, s := range specs {
			spec, ok := s.(map[string]any)
			if !ok {
				continue
			}
			id, ok := spec["id"].(string)
			if !ok {
				continue
			}
			out = append(out, declaredSpec{File: file, ID: id, Anchor: anchorLine(text, `"`+id+`"`), Spec: spec})
		}
	}
	return out
}

// anchorLine is the 1-based line needle first appears on; with no match,
// the line count of the text short of its last character.
func anchorLine(text, needle string) int {
	i := strings.Index(text, needle)
	if i < 0 {
		i = len(text) - 1
		if i < 0 {
			i = 0
		}
	}
	return strings.Count(text[:i], "\n") + 1
}

// clip is s cut to n UTF-16 units, as JavaScript's slice cuts it.
func clip(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}
