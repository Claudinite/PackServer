# Pack pages and the pre-install manifest

What a pack page shows and promises. The manifest's derivation is REQ-VAL-046; the score's display is
REQ-SCORE-007; the page layout is [../ui/sitemap.md](../ui/sitemap.md).

## REQ-SEARCH-014 The pack page shows the full public summary

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: SITE pack page; Ariel, 2026-10-22 (the "No public repo" marker)
- coverage: scenario

A pack page shows name, publisher with its verification facts, newest version with `published_at`,
visibility, stars, rating, 30-day fetches, the count of public repositories declaring the pack, the
pre-install manifest above the README, an adopt panel (the `cn adopt <id>` line, the
`packs.declared` entry and the MCP call), a repository link or a prominent "No public repo" marker,
the contents summary by part, the pack score and the validation status.

## REQ-VAL-042 The public view shows verification facts, capabilities, provenance, hashes and the full report

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-VAL §6, §3.13; Ariel, 2026-10-22 (sitemap decision 7, PR #4 commit 79e7900)
- coverage: scenario

The pack page and `get_pack` show the version's verification facts, pre-install manifest,
provenance, upload and canonical hashes, validation date and rules version, warning counts by
category, which capabilities the version marked new, and the full report of the published version;
the report of a never-published version is shown only to its publisher and to admins.

## REQ-SEARCH-022 Every file of a public pack is readable on the site

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: Ariel, 2026-10-22; docs/decisions.md (pack files are readable on the site)
- coverage: scenario+ui (the read-only rendering and the section anchors are observed in the browser driver)

The Contents tab lists every file of a public version by part and renders each one read-only, with
section anchors for comments (REQ-COMM-015); HTML and SVG inside a pack are shown as text.

## REQ-DELIV-012 Rendered READMEs are sanitised with nofollow ugc links

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §13
- coverage: scenario

The rendered README is sanitised and outbound links carry `rel="nofollow ugc"`.

The publisher profile page is REQ-SCOPE-015 in [publishing.md](publishing.md).

## REQ-TELEM-005 The publisher dashboard shows per-pack status and the Needs-you queue

- status: active
- since: 2026-10
- actor: publisher
- source: SITE dashboard; SITE dashboard (PR #4 revision: the Needs-you queue)
- coverage: scenario

The publisher dashboard shows per pack: visibility, newest version, status (Live, Working, Needs
you), stars, fetches and open issues, and one "Needs you" list of everything blocked on the
publisher (approvals, failed validations, pending payments, expiring proofs, security reports).
