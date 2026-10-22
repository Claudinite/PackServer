package checks

import (
	"fmt"
	"strings"

	"claudinite.com/checksdk"
)

// A session that told the owner their comment was work, and then called
// nothing. The gate is the declared class: correction, feature and
// process-change each name work the session undertook; other is answered,
// not acted on. "No tool call at all" counts the whole session, subagents
// included, so a session that did any work is invisible here.
var workClasses = []string{"correction", "feature", "process-change"}

func init() {
	checksdk.Register(checksdk.Check{
		ID:   "work-request-not-started",
		Tags: []string{"work"},
		Doc:  "packs/basics/RULES.md",
		Why:  "the instructions governing a reply say what it opens with and none says it continues, so a turn can satisfy all of them, contain no work, and end",
		Run:  workRequestNotStarted,
	})
}

func workRequestNotStarted(repo checksdk.Repo) []checksdk.Finding {
	turns := repo.Session().OwnerTurns()
	if len(turns) == 0 {
		return nil
	}
	turn := turns[len(turns)-1]
	var declared []string
	for _, c := range workClasses {
		if turn.Has(c) {
			declared = append(declared, "`"+c+"`")
		}
	}
	if len(declared) == 0 || len(repo.Session().ToolCalls()) > 0 {
		return nil
	}
	return []checksdk.Finding{{
		Path:     "(conversation)",
		Sentence: fmt.Sprintf("the reply classified this comment %s and the session then called no tool at all", strings.Join(declared, ", ")),
		Fix:      "the classification line is the opening of a reply, not the reply — do the work it names now, in this turn. If the comment actually needed answering rather than acting on, its class is `other`",
	}}
}
