package checks

import (
	"fmt"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"

	"claudinite.com/checksdk"
)

// The write-surface gate for the improve-comments pass: it runs
// unattended and writes the repo's own source, so its boundary needs a
// machine guarantee. A file passes because its code is identical once the
// comments are stripped from both sides, never because the run says so.
//
// Failing on purpose: a file whose language the comment parser cannot
// read counts as code; an added or deleted code file is never comment-only;
// a deleted README.md is not an improvement to a README; and any change
// under the vendored mount, which the next update replaces whole.
//
// Relevance is the run's pinned commit subject, so the check runs wherever
// basics is declared and costs nothing on a branch that is not this pass.
var improveCommentsRun = regexp.MustCompile(`^Claudinite tidy: improve comments`)

// The prefix the task's precondition filters its scope by; that task
// imports nothing, so the test beside this check holds the two in step.
const mountPrefix = ".claudinite/shared/"

func init() {
	checksdk.Register(checksdk.Check{
		ID:   "improve-comments-scope",
		Tags: []string{"work"},
		Doc:  "packs/basics/skills/improve-comments/SKILL.md",
		Why:  "the pass runs unattended against the repo's own source, and its whole safety case is that a comment cannot change behaviour — a run that also moved a line has made an unreviewed code change wearing a housekeeping title",
		Run:  improveCommentsScope,
	})
}

func isReadme(p string) bool { return strings.ToLower(path.Base(p)) == "readme.md" }

func improveCommentsScope(repo checksdk.Repo) []checksdk.Finding {
	if repo.OnDefaultBranch() || !slices.ContainsFunc(repo.CommitMessages(), improveCommentsRun.MatchString) {
		return nil
	}
	deleted := map[string]bool{}
	for _, p := range repo.Deleted() {
		deleted[p] = true
	}
	seen := map[string]bool{}
	var paths []string
	for _, p := range append(append([]string{}, repo.ChangedFiles()...), repo.Deleted()...) {
		if !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	var out []checksdk.Finding
	for _, p := range paths {
		base := optional(repo.ReadBase(p))
		inMount := strings.HasPrefix(p, mountPrefix)
		readme := isReadme(p)
		switch {
		case inMount:
			out = append(out, checksdk.Finding{
				Path:     p,
				Sentence: fmt.Sprintf("an improve-comments run changed %s, which is inside the %s mount", p, mountPrefix),
				Fix:      fmt.Sprintf("revert %s — the mount is not this repo's source: the next update replaces it whole, so a comment improved there is gone by morning; take the change to the canon instead", p),
			})
		case readme:
			if !deleted[p] {
				continue
			}
			out = append(out, checksdk.Finding{
				Path:     p,
				Sentence: fmt.Sprintf("an improve-comments run deleted %s — a README may be improved, never removed", p),
				Fix:      "restore the file; deciding a document should not exist is a change that gets reviewed, not a comment pass",
			})
		case checksdk.CommentOnly(p, base, optional(repo.Read(p))):
		case !checksdk.CommentCheckable[checksdk.Ext(p)]:
			out = append(out, checksdk.Finding{
				Path:     p,
				Sentence: fmt.Sprintf("an improve-comments run changed %s, whose language the comment parser cannot read", p),
				Fix:      fmt.Sprintf("revert %s — outside the parser's set a file counts as code, so nothing here can show the change was only comments; leave them to a change that gets reviewed", p),
			})
		default:
			what := fmt.Sprintf("an improve-comments run changed more than the comments in %s", p)
			if base == nil || deleted[p] {
				what = fmt.Sprintf("an improve-comments run added or deleted %s, which is never a comment-only change", p)
			}
			out = append(out, checksdk.Finding{
				Path: p, Sentence: what,
				Fix: "keep the branch to comment text in code files and to README.md content — a rename, a moved line or a reformat is its own change, with its own review",
			})
		}
	}
	return out
}

func optional(s string, ok bool) *string {
	if !ok {
		return nil
	}
	return &s
}
