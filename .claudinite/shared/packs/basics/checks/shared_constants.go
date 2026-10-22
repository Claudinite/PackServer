package checks

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

	"claudinite.com/checksdk"
)

// A data-driven drift guard for a value copied across files that cannot
// share an import (a label spanning a YAML workflow and a JS module; a
// repo slug in prod code and its test). The cases are the basics entry's
// config.sharedConstants; none is a no-op. Each entry is {what, value,
// counts}: counts maps a repo-relative path to the exact number of times
// the value appears there, and what names the places and why the split is
// forced. A count mismatch means a rename touched some copies but not all.
//
// A value that changes over time (a version bumped each release) sets
// "regex": true: value is matched as a regular expression, counts still
// bound the matches per file, and every match across the files must be
// identical, so the guard catches drift without pinning the value.
//
// An entry whose watched files are all JS/TS is a misuse, not drift: those
// files can share an import, so the value belongs in one module.
var importableExtensions = map[string]bool{"js": true, "mjs": true, "cjs": true, "jsx": true, "ts": true, "tsx": true, "mts": true, "cts": true}

// settingsFiles are the spellings of the member's settings file, which is
// where an entry's own fault is reported.
var settingsFiles = []string{".claudinite/settings.yaml", ".claudinite/settings.json", ".claudinite/settings.toml"}

func init() {
	checksdk.Register(checksdk.Check{
		ID:   "shared-constants",
		Tags: []string{"world"},
		Doc:  "packs/basics/RULES.md",
		Why:  "a value duplicated across files that can't share an import drifts silently when a rename or bump lands in some but not all",
		Run:  sharedConstants,
	})
}

func settingsFile(repo checksdk.Repo) string {
	for _, f := range settingsFiles {
		if repo.Exists(f) {
			return f
		}
	}
	return settingsFiles[0]
}

func fileExtension(p string) string {
	base := p[strings.LastIndex(p, "/")+1:]
	dot := strings.LastIndex(base, ".")
	if dot <= 0 {
		return ""
	}
	return strings.ToLower(base[dot+1:])
}

func sharedConstants(repo checksdk.Repo) []checksdk.Finding {
	var cfg struct {
		SharedConstants []any `json:"sharedConstants"`
	}
	_ = json.Unmarshal(repo.PackConfig("basics"), &cfg)
	if len(cfg.SharedConstants) == 0 {
		return nil
	}
	settings := settingsFile(repo)
	var out []checksdk.Finding
	at := func(p, what, fix string) {
		out = append(out, checksdk.Finding{Path: p, Sentence: what, Fix: fix})
	}
	for i, raw := range cfg.SharedConstants {
		entry, _ := raw.(map[string]any)
		value, _ := entry["value"].(string)
		what, _ := entry["what"].(string)
		counts, _ := entry["counts"].(map[string]any)
		label := fmt.Sprintf("entry #%d", i+1)
		if value != "" {
			label = `"` + value + `"`
		}
		if entry == nil || value == "" || strings.TrimSpace(what) == "" || len(counts) == 0 {
			at(settings, fmt.Sprintf(`malformed sharedConstants %s: needs a non-empty "value", a "what" naming the places and why the split is forced, and a non-empty "counts" map`, label),
				`shape each entry as { "what": "...", "value": "...", "counts": { "repo/relative/path": N } }`)
			continue
		}
		paths := make([]string, 0, len(counts))
		for p := range counts {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		allImportable := len(paths) > 1
		for _, p := range paths {
			allImportable = allImportable && importableExtensions[fileExtension(p)]
		}
		if allImportable {
			at(settings, fmt.Sprintf("sharedConstants %s watches only same-technology files that can share an import (%s) — a shared-constant is for a value copied across files that CAN'T", label, strings.Join(paths, ", ")),
				fmt.Sprintf("export %s from one module and import it into the other(s), then drop this entry (%s)", label, what))
			continue
		}
		var re *regexp.Regexp
		if entry["regex"] == true {
			var err error
			if re, err = regexp.Compile(value); err != nil {
				at(settings, fmt.Sprintf(`sharedConstants %s sets "regex": true but "value" is not a valid regular expression: %v`, label, err),
					`fix the pattern, or drop "regex": true to match the value as a flat literal`)
				continue
			}
		}
		type hit struct{ rel, value string }
		var matched []hit
		for _, rel := range paths {
			expected, ok := counts[rel].(float64)
			if !ok || expected < 0 || expected != math.Trunc(expected) {
				at(settings, fmt.Sprintf("sharedConstants %s gives a non-integer count for %s", label, rel),
					fmt.Sprintf(`set "counts"["%s"] to the number of times %s must appear in that file`, rel, label))
				continue
			}
			text, ok := repo.Read(rel)
			if !ok {
				at(settings, fmt.Sprintf("sharedConstants %s watches %s, but that file does not exist", label, rel),
					fmt.Sprintf(`the value's home moved or was removed — update the entry's "counts" (%s)`, what))
				continue
			}
			var actual int
			if re != nil {
				hits := re.FindAllString(text, -1)
				actual = len(hits)
				for _, h := range hits {
					matched = append(matched, hit{rel, h})
				}
			} else {
				actual = strings.Count(text, value)
			}
			if actual != int(expected) {
				at(rel, fmt.Sprintf("expected %d occurrence(s) of %s but found %d", int(expected), label, actual),
					fmt.Sprintf("a rename left this file out of sync — fix the value here, or adjust the entry's count if the change is intended (%s)", what))
			}
		}
		if re != nil && len(matched) > 1 {
			var distinct []string
			where := map[string][]string{}
			for _, m := range matched {
				if _, seen := where[m.value]; !seen {
					distinct = append(distinct, m.value)
				}
				where[m.value] = append(where[m.value], m.rel)
			}
			if len(distinct) > 1 {
				parts := make([]string, len(distinct))
				for i, v := range distinct {
					q, _ := json.Marshal(v)
					parts[i] = fmt.Sprintf("%s in %s", q, strings.Join(where[v], ", "))
				}
				at(settings, fmt.Sprintf("sharedConstants %s matches differing values across files — %s", label, strings.Join(parts, "; ")),
					fmt.Sprintf("bring the copies back into sync (%s)", what))
			}
		}
	}
	return out
}
