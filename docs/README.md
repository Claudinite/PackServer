# PackServer specification

PackServer is the registry behind **Claudinite Packs** at `registry.claudinite.com`: the one place
Claudinite packs are published, validated, found and fetched. This directory is its normative
spec: what the product does and why. Research lives in the PRs the decision log cites; execution
plans live in issues and PRs, not here.

## Reading order

1. [product/overview.md](product/overview.md): what PackServer is, for whom, and the bottom line.
2. [product/scope.md](product/scope.md): what is in and out, and the non-goals.
3. [product/personas.md](product/personas.md), [product/glossary.md](product/glossary.md).
4. [requirements/README.md](requirements/README.md): the requirement register by area. Every
   promise has a stable `REQ-AREA-NNN` id.
5. [architecture/overview.md](architecture/overview.md), then the architecture pages it links.
6. [security/threat-model.md](security/threat-model.md) and [security/controls.md](security/controls.md).
7. [ui/design-principles.md](ui/design-principles.md), [ui/sitemap.md](ui/sitemap.md), [ui/flows.md](ui/flows.md).
8. [operations/release.md](operations/release.md), [operations/monitoring.md](operations/monitoring.md),
   [operations/cost.md](operations/cost.md).
9. [decisions.md](decisions.md): every decision with its date and rationale, the defaults taken,
   and the one question still open.

## Layout

| Folder | Holds |
|---|---|
| `product/` | Overview, scope and non-goals, personas, glossary |
| `requirements/` | Functional requirements by area, one id per promise |
| `architecture/` | System overview, Workers and trust boundaries, data stores, APIs, signing and the index, the validation pipeline |
| `security/` | Threat model and the controls that answer it |
| `ui/` | Design principles, sitemap, flows |
| `operations/` | Release and shadow traffic, monitoring, cost |
| `decisions.md` | Decision log and defaults |

## Conventions

- Each fact lives in one place; other pages link to it rather than restate it.
- A requirement is one or two testable sentences under its id. Ids are never reused or
  renumbered; a retired id stays listed as retired.
- "Pending decision A6" marks the one spot where the spec uses a recommended answer Ariel has not
  yet confirmed (the pack score formula).
- Vocabulary follows [product/glossary.md](product/glossary.md): a *member* is a repository running
  Claudinite; a person is *signed in*; a pack is *declared*, *adopted* and *vendored*, never
  installed.
