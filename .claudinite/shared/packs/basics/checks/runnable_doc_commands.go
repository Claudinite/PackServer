package checks

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"claudinite.com/checksdk"
)

// A `node <path>` written in a doc is a command an agent will run, and
// nothing opens it until one does. Only paths the corpus owns are judged:
// a pack's prose legitimately names files in the consuming repo, so two
// shapes are checked and the rest skipped:
//
//  1. placeholder-rooted (`node <engine>/hooks/x.mjs`): whatever the
//     placeholder means, the rest is a real path suffix or the command
//     names nothing;
//  2. mount-rooted (`node .claudinite/shared/packs/…`): the mount mirrors
//     the canon, so the path below it resolves against this tree.
var (
	nodeCommand = regexp.MustCompile(`\bnode\s+((?:<[a-z-]+>|[\w.@/-])[\w.@/<>-]*\.mjs)\b`)
	mountPath   = regexp.MustCompile(`^\.claudinite/shared/`)
	placeholder = regexp.MustCompile(`^<[a-z-]+>/`)
	// Only the pack docs this repo authors: the vendored mount is canon
	// output a member may never edit.
	authoredDoc = regexp.MustCompile(`^(\.claudinite/local/)?packs/.+\.md$`)
	// A pack's own docs/ never vendors: maintainer reference no mount
	// carries, out of scope like the mount.
	packDocsDir = regexp.MustCompile(`^(\.claudinite/local/)?packs/[^/]+/docs/`)
)

func init() {
	checksdk.Register(checksdk.Check{
		ID:   "runnable-doc-commands",
		Tags: []string{"world"},
		Doc:  "packs/basics/README.md",
		Why:  "a command in prose is opened only when an agent runs it, so a path left behind by a move goes on instructing every session that follows the doc, with nothing red anywhere",
		Run:  runnableDocCommands,
	})
}

func runnableDocCommands(repo checksdk.Repo) []checksdk.Finding {
	paths := repo.Files()
	resolves := func(suffix string) bool {
		return slices.ContainsFunc(paths, func(f string) bool { return f == suffix || strings.HasSuffix(f, "/"+suffix) })
	}
	var out []checksdk.Finding
	for _, file := range paths {
		if !authoredDoc.MatchString(file) || packDocsDir.MatchString(file) {
			continue
		}
		text, ok := repo.Read(file)
		if !ok {
			continue
		}
		for _, m := range nodeCommand.FindAllStringSubmatch(text, -1) {
			p := m[1]
			switch {
			case placeholder.MatchString(p):
				suffix := placeholder.ReplaceAllString(p, "")
				if resolves(suffix) {
					continue
				}
				out = append(out, checksdk.Finding{
					Path:     file,
					Sentence: fmt.Sprintf("tells an agent to run `node %s`, and no file in this repo ends with `%s`", p, suffix),
					Fix:      "point the command at the file that owns that code now — and prefer a base the doc can derive from its own location, so the next move cannot silently orphan it again",
				})
			case mountPath.MatchString(p):
				inCanon := mountPath.ReplaceAllString(p, "")
				if repo.Exists(p) || repo.Exists(inCanon) {
					continue
				}
				out = append(out, checksdk.Finding{
					Path:     file,
					Sentence: fmt.Sprintf("tells an agent to run `node %s`, which the mount does not carry", p),
					Fix:      fmt.Sprintf("name the module that does the job now; a mount path is vendored canon, so `%s` is where it must exist", inCanon),
				})
			}
		}
	}
	return out
}
