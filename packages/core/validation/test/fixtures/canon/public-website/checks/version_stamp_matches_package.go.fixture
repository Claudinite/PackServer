// Package checks holds the public-website pack's coded checks.
package checks

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"claudinite.com/checksdk"
)

// A page names the released version in a title="version …" attribute,
// a copy of package.json's version, the record a release advances. The
// bump writes both in one run; this check is that generator's drift
// guard. Every page carrying a stamp is in scope, wherever it sits: the
// stamp is the page's own opt-in.
const versionRecord = "package.json"

// The stamp and the page shape, as public/version.mjs (the bump) writes
// and reads them.
var stamp = regexp.MustCompile(`title="version [^"]*"`)

func isPage(p string) bool { return strings.HasSuffix(p, ".html") }

func init() {
	checksdk.Register(checksdk.Check{
		ID:    "version-stamp-matches-package",
		Tags:  []string{"world"},
		Since: "2026-09-13",
		Doc:   "packs/public-website/RULES.md",
		Why:   "the stamp is the only place a visitor can read which build they are on, and a stale copy names a build that was never served",
		Run:   versionStampMatchesPackage,
	})
}

func versionStampMatchesPackage(repo checksdk.Repo) []checksdk.Finding {
	record, ok := repo.Read(versionRecord)
	if !ok {
		return nil
	}
	var pkg map[string]any
	if json.Unmarshal([]byte(record), &pkg) != nil {
		return nil
	}
	version := jsString(pkg["version"])
	if version == "" {
		return nil
	}
	var out []checksdk.Finding
	seen := map[string]bool{}
	for _, page := range append(append([]string{}, repo.Tracked()...), repo.Files()...) {
		if seen[page] || !isPage(page) {
			continue
		}
		seen[page] = true
		text, ok := repo.Read(page)
		if !ok {
			continue
		}
		for i, line := range strings.Split(text, "\n") {
			for _, s := range stamp.FindAllString(line, -1) {
				stamped := s[len(`title="version `) : len(s)-1]
				if stamped == version {
					continue
				}
				out = append(out, checksdk.Finding{
					Path: page, Line: i + 1,
					Sentence: fmt.Sprintf("the page names version %s, but %s says %s", stamped, versionRecord, version),
					Fix:      "run `node .claudinite/shared/packs/public-website/bump-version.mjs --stamp-only` — it stamps every page from package.json and consumes no version number; never hand-edit either side",
				})
			}
		}
	}
	return out
}

// jsString is a truthy JSON value as a template literal writes it, ""
// for a falsy one.
func jsString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		if x == 0 {
			return ""
		}
		b, _ := json.Marshal(x)
		return string(b)
	case bool:
		if !x {
			return ""
		}
		return "true"
	case nil:
		return ""
	}
	b, _ := json.Marshal(v)
	return string(b)
}
