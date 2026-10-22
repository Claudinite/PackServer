// Package checks holds the node pack's coded checks.
package checks

import (
	"fmt"
	"strings"

	"claudinite.com/checksdk"
)

// The testable slice of "earn each dependency": only the event, a
// package.json gaining a dependency it did not carry at the merge base,
// has a signature; the judgment stays in the prose the finding points to.
// It fires once, on the branch that adds the name; a group move or a
// version bump is not an addition.
var depKeys = []string{"dependencies", "devDependencies", "peerDependencies", "optionalDependencies"}

func init() {
	checksdk.Register(checksdk.Check{
		ID:     "earn-each-dependency",
		Tags:   []string{"work"},
		OnFail: "advise",
		Doc:    "packs/basics/RULES.md",
		Why:    "every dependency is standing surface area and supply-chain weight; a built-in or a few lines often covers a narrow job with none of it",
		Run:    earnEachDependency,
	})
}

// nearRoot is the pack's marker scope, the root or one folder down, so a
// nested fixture or example manifest never counts.
func nearRoot(f string) bool {
	parts := strings.Split(f, "/")
	return parts[len(parts)-1] == "package.json" && len(parts) <= 2
}

func earnEachDependency(repo checksdk.Repo) []checksdk.Finding {
	var out []checksdk.Finding
	for _, file := range repo.ChangedFiles() {
		if !nearRoot(file) {
			continue
		}
		head, base := checksdk.JSONPair(repo, file)
		headObj, ok := head.(map[string]any)
		if !ok {
			continue
		}
		carried := map[string]bool{}
		if baseObj, ok := base.(map[string]any); ok {
			for _, k := range depKeys {
				for name := range object(baseObj[k]) {
					carried[name] = true
				}
			}
		}
		for _, k := range depKeys {
			for _, name := range sortedKeys(object(headObj[k])) {
				if carried[name] {
					continue
				}
				out = append(out, checksdk.Finding{
					Path:     file,
					Sentence: fmt.Sprintf("%q added to %s", name, k),
					Fix:      "confirm it earns its place — a built-in or a few lines often does a narrow job with no dependency; if it is warranted this advisory needs no change",
				})
			}
		}
	}
	return out
}

func object(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}
