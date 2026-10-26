package checks

import (
	"fmt"
	"path"
	"regexp"
	"strings"

	"claudinite.com/checksdk"
)

// A label counts as path-like only when it has at least one slash; a bare
// basename label cannot be reliably resolved and flags nothing.
var pathLike = regexp.MustCompile(`^\.{0,2}/?[\w.-]+(/[\w.-]+)+$`)

func init() {
	checksdk.Register(checksdk.Check{
		ID:   "markdown-link-labels",
		Tags: []string{"world"},
		Doc:  "packs/basics/skills/repo-text-sweeps/SKILL.md",
		Why:  "a Markdown link carries its path twice — an href-only rewrite leaves the doc pointing right but reading wrong",
		Run:  markdownLinkLabels,
	})
}

func markdownLinkLabels(repo checksdk.Repo) []checksdk.Finding {
	var out []checksdk.Finding
	for _, file := range repo.Files() {
		if !strings.HasSuffix(file, ".md") {
			continue
		}
		text, ok := repo.Read(file)
		if !ok {
			continue
		}
		for _, l := range checksdk.ExtractLinks(text) {
			label, _, _ := strings.Cut(l.Label, "#")
			if !pathLike.MatchString(label) {
				continue
			}
			target := joinPath(path.Dir(file), l.Target)
			if target == joinPath(path.Dir(file), label) || target == joinPath("", label) {
				continue
			}
			out = append(out, checksdk.Finding{
				Path: file, Line: l.Line,
				Sentence: fmt.Sprintf("label reads %q but the target resolves to %s", l.Label, target),
				Fix:      "rewrite the visible label to match the target (or vice versa) — both halves carry the path",
			})
		}
	}
	return out
}

// joinPath joins and cleans as Node's path.join does, keeping a trailing
// slash the last part carries.
func joinPath(dir, p string) string {
	j := path.Join(dir, p)
	if strings.HasSuffix(p, "/") && !strings.HasSuffix(j, "/") {
		j += "/"
	}
	return j
}
