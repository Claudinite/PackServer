package checks

import (
	"fmt"
	"sort"
	"strings"

	"claudinite.com/checksdk"
)

// A declared check is its messages: the format carries no comments, no
// description and no doc pointer, so what, fix and failureMessage are the
// whole teaching surface. That works only while each stays one readable
// clause, so each is capped in words, and no fix is hand-repeated across
// one rule's assertions (the rule-level fix exists so a shared remedy is
// written once).
const maxWords = 32

var messageKeys = map[string]bool{"what": true, "fix": true, "failureMessage": true}

type messageField struct {
	Key, Value  string
	AtRuleLevel bool
}

func init() {
	checksdk.Register(checksdk.Check{
		ID:   "declared-check-messages",
		Tags: []string{"world"},
		Why:  "a declaration has no comments or doc pointer — its messages are the whole check, and a message that runs to a paragraph (or a remedy pasted per assertion) stops being readable as one",
		Run:  declaredCheckMessages,
	})
}

func declaredCheckMessages(repo checksdk.Repo) []checksdk.Finding {
	var out []checksdk.Finding
	for _, d := range declaredSpecs(repo) {
		var fields []messageField
		messageFields(d.Spec, true, &fields)
		for _, f := range fields {
			if n := words(f.Value); n > maxWords {
				out = append(out, checksdk.Finding{
					Path: d.File, Line: d.Anchor,
					Sentence: fmt.Sprintf("%q has a %s of %d words (max %d): %q…", d.ID, f.Key, n, maxWords, clip(f.Value, 60)),
					Fix:      "cut the field to its one clause — the evidence in `what`, the single action in `fix`, the single consequence in `failureMessage`",
				})
			}
		}
		counts := map[string]int{}
		for _, f := range fields {
			if f.Key == "fix" && !f.AtRuleLevel {
				counts[f.Value]++
			}
		}
		var repeated []string
		for v, n := range counts {
			if n > 1 {
				repeated = append(repeated, v)
			}
		}
		sort.Strings(repeated)
		for _, v := range repeated {
			out = append(out, checksdk.Finding{
				Path: d.File, Line: d.Anchor,
				Sentence: fmt.Sprintf("%q repeats one fix verbatim across %d assertions: %q…", d.ID, counts[v], clip(v, 60)),
				Fix:      `state the shared remedy once as the rule-level "fix" and drop the per-assertion copies`,
			})
		}
	}
	return out
}

// messageFields collects every message-field string under node, marking
// the ones at the rule level (a rule-level fix is the dedup mechanism,
// never a duplicate).
func messageFields(node any, atRuleLevel bool, out *[]messageField) {
	switch v := node.(type) {
	case []any:
		for _, x := range v {
			messageFields(x, false, out)
		}
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if s, ok := v[k].(string); ok && messageKeys[k] {
				*out = append(*out, messageField{Key: k, Value: s, AtRuleLevel: atRuleLevel})
			} else {
				messageFields(v[k], false, out)
			}
		}
	}
}

func words(s string) int { return len(strings.FieldsFunc(s, checksdk.IsJSSpace)) }
