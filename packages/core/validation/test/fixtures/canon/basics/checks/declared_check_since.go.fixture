package checks

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"claudinite.com/checksdk"
)

// An action check is re-judged over the whole session transcript at Stop,
// so a blocking one that lands mid-session convicts calls the session made
// before it existed, and a past call has no clearing move. since buys a
// new check its grace window; this check makes the dating happen when the
// declaration is written.
var sinceDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func init() {
	checksdk.Register(checksdk.Check{
		ID:    "declared-check-since",
		Tags:  []string{"world"},
		Since: "2026-09-06",
		Why:   "a blocking action check with no usable `since` convicts the tool calls a session made before the check existed, and a past call has no clearing move",
		Run:   declaredCheckSince,
	})
}

func declaredCheckSince(repo checksdk.Repo) []checksdk.Finding {
	var out []checksdk.Finding
	for _, d := range declaredSpecs(repo) {
		if d.Spec["scope"] != "action" || d.Spec["on_fail"] != "block" {
			continue
		}
		since, present := d.Spec["since"]
		if s, ok := since.(string); ok && datesTheCheck(s) {
			continue
		}
		what := fmt.Sprintf("%q blocks on tool calls and carries no \"since\"", d.ID)
		if present {
			what = fmt.Sprintf("%q blocks on tool calls and its \"since\" of %q is not a YYYY-MM-DD date", d.ID, clip(jsString(since), 30))
		}
		out = append(out, checksdk.Finding{
			Path: d.File, Line: d.Anchor, Sentence: what,
			Fix: `add "since": the YYYY-MM-DD date this check lands, so its first two weeks report without blocking the sessions that predate it`,
		})
	}
	return out
}

// datesTheCheck reports whether since is a date the grace window reads.
func datesTheCheck(since string) bool {
	if !sinceDate.MatchString(since) {
		return false
	}
	_, err := time.Parse("2006-01-02", since)
	return err == nil
}

// jsString is v as JavaScript's String() writes a JSON value.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case float64, bool:
		return fmt.Sprint(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}
