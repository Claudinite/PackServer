package checks

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"claudinite.com/checksdk"
)

// The `Comment class:` line must carry the class alone, any explanation
// on the next line: every class token on the line is read as declared,
// so an explanation sharing the line declares whatever it mentions. This
// asserts the form, not the author's intent: the harm is a class token
// being present on the line, so only a line whose content is the
// declaration and nothing else passes. A genuinely mixed comment names
// each part, comma-separated, on that one line; Markdown emphasis around
// the bare declaration is tolerated.
//
// Advisory: the transcript is append-only, so a blocking finding here
// could never converge.
const classToken = `(?:correction|feature|process[\s-]change|other)`

// | is deliberately not a separator: it is how a menu is written out, so
// the menu pasted verbatim fails instead of reading as four classes.
var conformingDeclaration = regexp.MustCompile(`(?i)^` + classToken + `(?:\s*(?:,|&|\+|and)\s*` + classToken + `)*\.?$`)

var emphasisEdges = regexp.MustCompile(`^[*_]+|[*_]+$`)

func init() {
	checksdk.Register(checksdk.Check{
		ID:     "comment-classification-form",
		Tags:   []string{"work"},
		OnFail: "advise",
		Doc:    "packs/basics/RULES.md",
		Why:    "classesIn() matches every class token anywhere on the classification line, so an explanation sharing that line declares whatever it happens to mention, not just what the author meant",
		Run:    commentClassificationForm,
	})
}

func jsTrim(s string) string { return strings.TrimFunc(s, checksdk.IsJSSpace) }

func commentClassificationForm(repo checksdk.Repo) []checksdk.Finding {
	turns := repo.Session().OwnerTurns()
	if len(turns) == 0 {
		return nil
	}
	turn := turns[len(turns)-1]
	line := turn.ClassLine
	if line == "" {
		return nil
	}
	declaration := jsTrim(emphasisEdges.ReplaceAllString(jsTrim(line[strings.Index(line, ":")+1:]), ""))
	if conformingDeclaration.MatchString(declaration) {
		return nil
	}
	declared := append([]string{}, turn.Classes...)
	if len(declared) == 0 {
		return nil
	}
	sort.Strings(declared)
	for i, c := range declared {
		declared[i] = "`" + c + "`"
	}
	return []checksdk.Finding{{
		Path:     "(conversation)",
		Sentence: fmt.Sprintf("the `Comment class:` line carries more than the class it means, so it is read as declaring %s", strings.Join(declared, ", ")),
		Fix:      "write the class alone on its own line, and put any explanation on the NEXT line; a genuinely mixed comment names each part it really is, comma-separated, on that one line. The transcript is append-only, so a clean re-declaration further down does not override this one",
	}}
}
