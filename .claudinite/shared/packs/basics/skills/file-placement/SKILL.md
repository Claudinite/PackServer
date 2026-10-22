---
name: file-placement
description: Where a file should live: the reference-distance metric and its exemptions. Use before placing, moving or renaming a file, or when reviewing where one lives.
metadata:
  body: guidelines
  usage:
    expect: judgment

---

# File placement

Judge placement by the shape of the dependency graph against the folder tree: keep a file close to the files it actually depends on. A project-specific layout convention the consuming repo's own docs set — where tests go, where generated output lands, a framework-mandated folder — wins over the metric below.

## The reference-distance metric

Treat the repository as a tree of folders. For any reference one file makes to another (an import, an include, a relative-path link, a sibling asset it reads), measure the **distance** between them as the number of folder edges you traverse in that tree to get from one file's folder to the other's:

- **Distance 0** — both files are in the **same folder**. The reference is local.
- **Distance 1** — the target is **one folder up or one folder down** (a parent or a direct child folder). One edge.
- **Distance 2** — the target is in a **sibling folder**: a different child of the same parent. You go **up one** edge to the shared parent, then **down one** edge into the sibling. Two edges.
- **Distance _n_** — in general, the count of folder edges on the shortest path between the two folders in the tree. Each "up to a common ancestor" step and each "down into a subfolder" step is one edge.

> A sibling reference is **distance 2** (up one, then down one) under this edge-counting model — not 3. Keep this consistent: the distance is just the length of the shortest folder-to-folder path in the tree.

Distance 0 and 1 are *cohesion*: the file and what it needs are neighbors. Anything 2 or higher is *reach* — the file is grabbing across the tree.

## The rule

**A file should mostly reference files at distance 0 or 1.** Same folder, the folder above, or a folder below. That is the healthy case: a module knows its neighbors and its parent/children, and little else.

It is a **code smell** when:

- many of a file's references are at distance 2+, or
- a single reference is at a large distance (reaching across several folders to a far corner of the tree), or
- a whole folder's files all reach into the same distant folder — that pair of folders probably wants to be adjacent, or merged.

High average reference-distance means the folder structure and the dependency structure disagree. The tree is supposed to *encode* what depends on what; when files routinely reach far away, the tree has stopped telling the truth.

## What to do about a smell

Don't treat a long reference as something to suppress — treat it as a signal that placement is wrong. Options, roughly in order of preference:

- **Move the file** next to what it depends on, so the reference collapses to distance 0 or 1.
- **Move the dependency** the other way, if the dependency is the thing that's misplaced and several files want it nearby.
- **Lift a shared dependency** to the nearest common ancestor when several sibling folders all reach for it — distance 2-from-each becomes distance-1 from a parent everyone already touches.
- **Introduce a boundary** (a small public entry point / index for a subtree) so outsiders reference *one* near file instead of reaching deep into the subtree's internals. This converts many deep references into one shallow one.
- **Accept it, deliberately,** for genuine cross-cutting concerns (a top-level shared/util/config that everything legitimately depends on). These exist; the point is they should be *few and named*, not the accidental norm.

## A file used by exactly one unit belongs inside that unit

The distance metric asks *how far* a reference reaches. This asks *how many* things reach at all, and it is the sharper question when the answer is **one**.

**A file — code or prose — whose only consumer is a single self-contained unit lives inside that unit's folder.** A "unit" here is any directory the project treats as one thing: a scheduled task, a command, a plugin, a feature module. If exactly one of them imports the file, reads it, or links to it, then the file is part of it, and the folder should say so.

This is not the distance rule restated. A helper one level up from its only caller scores a perfectly healthy distance 1 and is still misplaced: sitting outside the unit it advertises itself as shared, so the next author treats it as a public surface, and it accumulates callers it was never designed for. Deleting the unit also leaves the helper behind as orphaned code nobody dares remove, because its location implies someone else might need it. Moving it inside makes the unit **self-contained**: everything it owns travels, and is deleted, with it.

Apply it in both directions:

- **Two or more units use it** → it is genuinely shared. Lift it to their nearest common ancestor and leave it there; that is the shared-dependency move above, and the location is now telling the truth.
- **Exactly one uses it** → move it in, even when the reference was already short.

The usual exemptions still hold — a mandated location wins, and a project's test-location convention wins. Split a file whose *parts* have different audiences rather than leaving the whole thing outside for the sake of one shared export: move the single-consumer body inside the unit, lift the shared function to the common ancestor.

## Special case: files whose location is mandated

Some files **cannot** live next to what they relate to, because a tool or platform dictates exactly where they go. A GitHub workflow must sit under `.github/workflows/`; agent/config files live under `.claude/` (or `.cloud/`, `.vscode/`, `.devcontainer/`, etc.); many ecosystems require a manifest at the repo root (`package.json`, `pyproject.toml`, `Dockerfile`). Their placement is fixed by an external contract, not chosen by you.

**Exempt these from the distance metric.** A mandated-location file that "reaches far" into the code it acts on is not a smell — it has no choice, and moving the code to satisfy the metric would be backwards. Don't refactor to shorten a reference whose distance is forced by a tool's required path.

But the exemption is **narrow and one-directional**:

- It covers only the **mandated** file and **only the references the mandate forces.** A workflow under `.github/` referencing a script elsewhere is fine. Ordinary code reaching *into* `.github/` for something that didn't have to live there is still a smell — the metric applies normally in that direction.
- Keep the mandated file **thin**: a launcher that references one near entry point, not a file that reaches deep into many distant internals. Put the real logic in a normally-placed file at distance 0/1 from what it uses, and have the mandated file point at *that*. This keeps the long, forced reference single and shallow instead of spraying deep references from a corner of the tree.
- The exemption is for **truly mandated** locations, not merely conventional or convenient ones. "It's customary to put it here" is not a mandate — if you could place the file nearer its dependencies and the tooling wouldn't care, the normal rule still applies.

## Special case: test files

Tests are a common source of long references that are **not** placement smells. A project's test-location convention — a mirrored `test/` or `tests/` tree, a `__tests__/` folder, a `*_test.go` sibling, a `spec/` root — fixes where a test file lives, and that location is often far from the file under test. The resulting long reference from the test to the tested file is **forced by the convention, not by misplacement.**

**Don't move files to shorten a test reference, or vice versa.** Where a project already has a standard for test locations, that standard wins: leave the tested file where its production neighbors are (distance 0/1 from *them*), leave the test where the convention puts it, and accept the distance between them. Relocating production code to sit nearer its test — or scattering tests next to code when the project mirrors them into a separate tree — trades a real, project-wide standard for a metric the standard already overrides.

Apply the same narrowness as the mandated-location case: the exemption covers the **test → tested-file** reference that the convention forces, and it presumes the project *has* such a convention. Absent any standard, ordinary placement judgment still applies — co-locating a test with the code it exercises is a perfectly good distance-0 choice.

**When picking a test-location convention from scratch, mirror the source tree — one test per source file at the same relative path** (`src/<area>/<name>` tested by `test/<area>/<name>.test`). The path *is* the link: a source file never has to name its own test in a comment, and a missing or misfiled test is obvious at a glance. Keep departures (whole-interaction tests, tests with no single source file to mirror) few and deliberate.

## Special case: a plugin contract's shared lib

The two exemptions above cover a file whose *own location* is fixed. A third case fixes **both ends of a reference**: a framework that discovers extension modules at a mandated path *and* publishes the shared lib those modules must import at another mandated path. Every extension takes the same import, at whatever distance the two mandated paths happen to sit apart — a plugin importing its host's plugin API, a check module importing the engine's finding constructor.

**Exempt that reference too.** It is not a placement decision at either end: the extension can't move without ceasing to be discovered, and the lib is usually code the project doesn't own to restructure. The tell is universality — *every* extension of that kind takes the reference, in every repo, so a project can only ever waive it, never fix it. A waiver each adopter has to write is a rule flagging a constant.

Apply the same narrowness as the other two:

- It covers the **extension → published lib** direction only. Code reaching *into* an extension's folder, or an extension reaching somewhere other than the published lib, is judged normally.
- It covers the framework's **declared** surface — the paths it tells extensions they may import — and nothing past it. Reaching around that boundary into internals is not exempt; that's the reach-deep-into-a-subtree smell, and the boundary the framework already drew is what makes it visible.
- **Universal, not merely common.** A dependency several files happen to share is the lift-to-a-common-ancestor case above, and it is still fixable. This exemption is for the one every extension takes by construction.

Take the surface from wherever the framework already defines it, rather than restating it. If some other rule enforces "an extension may import only X," that same X is what placement should exempt — one definition, so the two can't drift apart and disagree about the same import.

In this corpus that means a pack module under `packs/` or `.claudinite/local/packs/` importing the engine surface (everything under `engine/` — `engineSurface()` in `engine/checks/helpers/module-imports.mjs`, the allow list the `pack-independence` barrier enforces; vendored under `.claudinite/shared/` in a consuming repo). A pack rule's `findings.mjs` import is therefore never a reach. A pack reaching into *another* pack, or deep into its own subtree, is judged normally.

## Tooling acts on paths: encode act-on-able distinctions structurally

A file's path is an interface not only for developers but for automated processes — build globs, linters, and access rules often act on a file by its location alone, without reading its content. When two kinds of file must be treated differently by tooling that reads only paths, make the distinction **structural**: give each kind its own folder so the path itself carries the signal.

Keep such a split fail-safe: name the narrower or less-protected kind explicitly, and let the safer behavior be the default, so a misplaced file lands on the safe side rather than the dangerous one.

This complements the reference-distance metric, which asks *what a file depends on*. This axis asks *what acts on the file by path* — and for path-driven tooling, placement is the only interface it sees.

## Why this works

- **Locality of change.** Edits ripple to neighbors, not across the repo. When related files sit together, a change and its blast radius share a folder.
- **The tree stays honest.** Folder structure should be a readable map of the dependency graph. Low reference-distance keeps the map matching the territory.
- **Cheaper navigation.** A reader following a reference travels a short path, not a tour of the tree.
- **Refactors localize.** Moving or deleting a subtree is safe when its outside references are few and shallow; it's perilous when half the repo reaches in.

## How to apply it

- When **placing a new file**, put it where its distance-0/1 neighbors are — with the files it will import and that will import it. If no such home exists, that's a hint the structure needs a new folder, not that the file goes "somewhere."
- When **reviewing**, scan a file's imports/links and ask how far each reaches. A cluster of distance-2+ references is a refactor prompt, not a nit.
- Use it as a **direction, not a hard gate.** The goal is low *average* reach and no surprising *far* reach — not a mechanical ban on distance ≥ 2.
- The check that measures this is **advisory and stays advisory.** It never fails a run and takes no acceptance entry in `.claudinite-settings.json`: a finding is a placement question to answer in the tree — move the file, lift the dependency, introduce an entry point, or judge the reach deliberate and leave it. Writing config to release it would be paying review cost to silence something that was never holding anything up.

