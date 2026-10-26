package checks

import (
	"fmt"
	"path"
	"regexp"
	"slices"
	"strings"

	"claudinite.com/checksdk"
)

// What the project's instruction file costs a session is what it brings,
// not what it holds: an @path line in CLAUDE.md pulls that file, and
// everything it imports in turn, into every window the repo opens. So the
// budget is over the resolved tree, in tokens.
//
// Only the root file: the harness loads that one, and a CLAUDE.md under a
// fixture or an example directory costs a session nothing.
const claudeMD = "CLAUDE.md"

// One import per line, the form the harness resolves: @ at the start of
// the line, then a path relative to the file the line is in.
var importLine = regexp.MustCompile(`^@(\S+)\s*$`)

// A ceiling rather than a target: the point is to notice the tree growing
// past what a session can carry alongside the work. A repo whose packs
// legitimately cost more says so by raising it here, deliberately.
const budgetTokens = 24000

func init() {
	checksdk.Register(checksdk.Check{
		ID:     "claude-md-length",
		Tags:   []string{"world"},
		OnFail: "advise",
		Why:    "every session in the repo pays for the whole import tree before it reads a line of the work, and the file that names it is often one line long",
		Run:    claudeMDLength,
	})
}

func claudeMDLength(repo checksdk.Repo) []checksdk.Finding {
	if !slices.Contains(repo.Files(), claudeMD) {
		return nil
	}
	tokens := checksdk.EstimateTokens(importedChars(repo, claudeMD))
	if tokens <= budgetTokens {
		return nil
	}
	return []checksdk.Finding{{
		Path:     claudeMD,
		Line:     1,
		Sentence: fmt.Sprintf("CLAUDE.md and what it imports come to %s tokens (budget %s)", thousands(tokens), thousands(budgetTokens)),
		Fix:      "cut the rules a check now enforces, move a multi-step procedure into a skill that loads on demand, and drop a rule another pack already carries; every one of them is paid for by every session, whether or not it applies",
	}}
}

// importedChars counts the tree under entry, each file once: a cycle is
// ordinary (two rule files pointing at each other still load once each),
// so the seen set bounds the walk. An import resolving to nothing costs
// no tokens and is not this check's finding.
func importedChars(repo checksdk.Repo, entry string) int {
	seen := map[string]bool{}
	queue := []string{entry}
	chars := 0
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		if seen[p] {
			continue
		}
		seen[p] = true
		text, ok := repo.Read(p)
		if !ok {
			continue
		}
		chars += checksdk.CountChars(text)
		for _, line := range strings.Split(text, "\n") {
			if m := importLine.FindStringSubmatch(line); m != nil {
				queue = append(queue, path.Join(path.Dir(p), m[1]))
			}
		}
	}
	return chars
}

// thousands writes n with en-US grouping commas.
func thousands(n int) string {
	s := fmt.Sprint(n)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}
