package checks

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"claudinite.com/checksdk"
)

// Node's default --test discovery skips dot-directories, so an invocation
// naming no path finds nothing and exits green, reading like a passing
// suite. An invocation whose argument resolves to no file is the same
// failure one step later. The surfaces are package.json scripts and
// .github/workflows/*.yml; a command carrying shell interpolation is not
// judged, since its arguments are not knowable from the artifact.

// The vendored mount is canon-owned and out of a member's test coverage.
const vendoredPrefix = ".claudinite/shared/"

var (
	separators = regexp.MustCompile(`\n|&&|\|\||[;|]`)
	quoteEdges = regexp.MustCompile(`^['"]|['"]$`)
	globChars  = regexp.MustCompile(`[*?[\]]`)
)

func init() {
	checksdk.Register(checksdk.Check{
		ID:    "test-discovery-resolves",
		Tags:  []string{"world"},
		Since: "2026-09-06",
		Doc:   "packs/node/RULES.md",
		Why:   "Node's test discovery ignores dot-directories, so an invocation naming no existing path (or a stale glob) runs zero tests and exits green — indistinguishable from a passing suite",
		Run:   testDiscoveryResolves,
	})
}

func tokenize(command string) []string {
	var out []string
	for _, t := range strings.FieldsFunc(command, checksdk.IsJSSpace) {
		out = append(out, quoteEdges.ReplaceAllString(t, ""))
	}
	return out
}

// globToRegexp reads a glob over /-separated repo paths: ** crosses
// folders (and **/ may match none), * and ? do not.
func globToRegexp(pattern string) *regexp.Regexp {
	var b strings.Builder
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case c == '*' && i+1 < len(pattern) && pattern[i+1] == '*':
			i++
			if i+1 < len(pattern) && pattern[i+1] == '/' {
				i++
				b.WriteString("(?:.*/)?")
			} else {
				b.WriteString(".*")
			}
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	re, err := regexp.Compile("^" + b.String() + "$")
	if err != nil {
		return regexp.MustCompile(`^$.`)
	}
	return re
}

// resolvesToFiles reports whether arg names at least one file: as a glob,
// an exact path, or a folder holding files.
func resolvesToFiles(arg string, paths []string) bool {
	if arg == "" {
		return false
	}
	if globChars.MatchString(arg) {
		re := globToRegexp(arg)
		return slices.ContainsFunc(paths, re.MatchString)
	}
	clean := strings.TrimRight(arg, "/")
	return slices.ContainsFunc(paths, func(p string) bool { return p == clean || strings.HasPrefix(p, clean+"/") })
}

// judgeCommand says whether a `node --test` in command names a path that
// resolves; judged is false for any other command or an interpolated one.
func judgeCommand(command string, paths []string) (judged, ok bool) {
	if strings.ContainsAny(command, "$`") {
		return false, false
	}
	tokens := tokenize(command)
	at := slices.IndexFunc(tokens, func(t string) bool { return t == "node" || strings.HasSuffix(t, "/node") })
	if at < 0 {
		return false, false
	}
	args := tokens[at+1:]
	if !slices.Contains(args, "--test") {
		return false, false
	}
	for _, a := range args {
		if !strings.HasPrefix(a, "-") && resolvesToFiles(a, paths) {
			return true, true
		}
	}
	return true, false
}

func testDiscoveryResolves(repo checksdk.Repo) []checksdk.Finding {
	var paths []string
	seen := map[string]bool{}
	for _, f := range append(append([]string{}, repo.Tracked()...), repo.Files()...) {
		if !seen[f] && !strings.HasPrefix(f, vendoredPrefix) {
			seen[f] = true
			paths = append(paths, f)
		}
	}
	var out []checksdk.Finding
	report := func(file string, line int, command string) {
		out = append(out, checksdk.Finding{
			Path: file, Line: line,
			Sentence: fmt.Sprintf("`%s` names no test path that exists in the tree, so it discovers nothing and exits green", strings.TrimFunc(command, checksdk.IsJSSpace)),
			Fix:      "pass an explicit path or glob for the tests, e.g. `node --test 'test/**/*.test.mjs'`, and confirm the run's test count is non-zero",
		})
	}
	if pkg, ok := repo.Read("package.json"); ok {
		var manifest struct {
			Scripts map[string]any `json:"scripts"`
		}
		_ = json.Unmarshal([]byte(pkg), &manifest)
		lines := strings.Split(pkg, "\n")
		for _, name := range sortedKeys(manifest.Scripts) {
			body, ok := manifest.Scripts[name].(string)
			if !ok {
				continue
			}
			for _, command := range separators.Split(body, -1) {
				if judged, ok := judgeCommand(command, paths); judged && !ok {
					at := slices.IndexFunc(lines, func(l string) bool { return strings.Contains(l, `"`+name+`":`) })
					report("package.json", at+1, command)
				}
			}
		}
	}
	for _, wf := range checksdk.WorkflowFiles(repo) {
		text, ok := repo.Read(wf)
		if !ok {
			continue
		}
		for i, line := range strings.Split(text, "\n") {
			for _, command := range separators.Split(line, -1) {
				if judged, ok := judgeCommand(command, paths); judged && !ok {
					report(wf, i+1, command)
				}
			}
		}
	}
	return out
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
