# Pack pages and the pre-install manifest

What a pack page shows and promises. The manifest's derivation is REQ-VAL-046; the score's display is
REQ-SCORE-007; the page layout is [../ui/sitemap.md](../ui/sitemap.md).

## REQ-SEARCH-014 The pack page leads with four things and keeps the rest one gesture away

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: SITE pack page; Ariel, 2026-10-22 (the "No public repo" marker); PD-REV C1, H6, M2, L2; docs/decisions.md D33
- coverage: scenario

A pack page's primary elements are the name and pitch, the publisher mark with its proof
(REQ-SCOPE-015), the pre-install manifest line above the README, and the adopt block (the
`cn adopt @scope/name` command and the `packs.declared` entry only). One gesture away: the newest
version with `published_at`, a repository link or the "No public repo" marker, the pack score,
rating, Pulse, the approximate declaring-repo count, the contents summary by part, validation
status and hashes; a private pack shows the lock glyph and nothing says "visibility". Until the
feature flag `cn_min_adopt_version` names a released engine, the adopt block reads "Preview:
adoptable with cn ≥ <version>" and omits the `packs.declared` entry. When the newest eligible
version, or every version, is `revoked` or `quarantined`, or the pack is "Reported, under review"
(REQ-MOD-009), the page leads with one status line carrying the reason and the advisory link, and
nothing else changes.

## REQ-VAL-042 The public view shows verification facts, capabilities, source, hashes and the full report

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-VAL §6, §3.13; Ariel, 2026-10-22 (sitemap decision 7, PR #4 commit 79e7900); PD-REV M5, M13
- coverage: scenario

The pack page and `get_pack` show the version's verification facts, pre-install manifest, source
(repository, commit, trusted publishing and whether the tree was verified, REQ-PUB-006), upload and
canonical hashes, validation date and rules version, warning counts by category in the trust
drawer, which capabilities the version marked new, and the full report of the published version;
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
- source: SITE dashboard; SITE dashboard (PR #4 revision: the Needs-you queue); PD-REV M1
- coverage: scenario

The publisher dashboard shows per pack: visibility, newest version, status (Live, Working, Needs
you), stars, fetches and open issues, and one "Needs you" list of everything blocked on the
publisher (approvals, failed validations, expiring proofs, security reports, a
pending Verified Publisher application); a first dashboard with no packs shows the New pack action
and nothing else.
