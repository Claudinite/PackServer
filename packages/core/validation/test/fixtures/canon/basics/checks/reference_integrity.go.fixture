package checks

import (
	"fmt"
	"path"
	"regexp"
	"strings"
	"sync"

	"claudinite.com/checksdk"
)

// A deleted path a migration record (<pack>/migrations/<date>-<slug>/)
// still names is not stale: it is the legacy shape the record documents.
// Matched on basename, read from the tracked tree and from the record's
// code, not the comments around it.
var migrationSpec = regexp.MustCompile(`(^|/)migrations/[^/]+/migration\.mjs$`)

func init() {
	checksdk.Register(checksdk.Check{
		ID:   "reference-integrity",
		Tags: []string{"work"},
		Doc:  "packs/basics/skills/repo-text-sweeps/SKILL.md",
		Why:  "a dangling reference breaks silently — no test fails when a doc link or index entry points at nothing",
		Run:  referenceIntegrity,
	})
}

func referenceIntegrity(repo checksdk.Repo) []checksdk.Finding {
	var out []checksdk.Finding
	for _, d := range checksdk.DeadLinks(repo, nil) {
		out = append(out, checksdk.Finding{
			Path: d.Path, Line: d.Line,
			Sentence: fmt.Sprintf("relative link → %s resolves to %s, which does not exist", d.Target, d.Resolved),
			Fix:      "correct the path or restore the target; when moving or deleting a file, update every inbound reference in the same change",
		})
	}
	for _, d := range checksdk.DanglingReferences(repo, migrationGoverns(repo)) {
		out = append(out, checksdk.Finding{
			Path: d.Path, Line: d.Line,
			Sentence: fmt.Sprintf("still references %s, which this branch deletes", d.Gone),
			Fix:      fmt.Sprintf("update or remove the reference — grep the whole tree for %q and fix every hit in this same change", d.Gone),
		})
	}
	return out
}

func migrationGoverns(repo checksdk.Repo) func(string) bool {
	var once sync.Once
	var records string
	return func(gone string) bool {
		once.Do(func() {
			var parts []string
			for _, f := range repo.Tracked() {
				if migrationSpec.MatchString(f) {
					text, _ := repo.Read(f)
					parts = append(parts, checksdk.StripComments(text))
				}
			}
			records = strings.Join(parts, "\n")
		})
		return strings.Contains(records, path.Base(gone))
	}
}
