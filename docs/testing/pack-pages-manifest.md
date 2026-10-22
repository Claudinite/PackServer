# Pack pages and the pre-install manifest

Mirrors [../requirements/pack-pages-manifest.md](../requirements/pack-pages-manifest.md). Pages are
read through the server-rendered HTML in-process (a parsed DOM, no browser); `IT-PAGE-*` is the id
prefix because the page's requirements come from four areas.

### IT-PAGE-001 The pack page leads with four things and keeps the rest one gesture away
- **Covers:** REQ-SEARCH-014
- **Runs:** push
- **Setup:** a public pack from a Verified org (domain proof `acme.com`), two versions, 3 stars, rating 4.2 from 5 reviews, about 120 fetches in 30 days, declared by 7 public repositories in the weekly scan, a guard and two skills, a linked repository; a second pack published by upload with no repository; a private pack read by an allowlisted person; a pack whose newest eligible version is `quarantined`; the feature flag `cn_min_adopt_version` unset, then set.
- **Action:** read each page anonymously (the private one as the allowlisted person) under both flag states.
- **Assert:** the primary elements are the name and pitch, the mark `● acme.com` with "Verified Publisher" only in its hover, the pre-install manifest line above the README, and the adopt block; with the flag unset the adopt block reads "Preview: adoptable with cn ≥ <version>" and has no `packs.declared` entry, with it set the block holds `cn adopt @scope/name` and the `packs.declared` entry only; one gesture away are the newest version with `published_at`, the repository link, the score, 4.2, Pulse, "about 120 fetches", "7 repositories (approximate, weekly)", the contents summary by part, the validation status and the hashes; the second page shows the "No public repo" marker in place of the link; the private page shows the lock glyph and the word "visibility" appears nowhere; the quarantined pack's page leads with one status line carrying the reason and the advisory link and nothing else differs.

### IT-PAGE-002 The public view shows verification facts, capabilities, source, hashes and the report
- **Covers:** REQ-VAL-042
- **Runs:** push
- **Setup:** version `1.1.0` of a trusted-published pack that marked a new guard, with `source_verified: true`; an upload-published version of another pack; an unpublished run of a third pack.
- **Action:** read the pages and `get_pack`; read the unpublished run's report anonymously, as its publisher and as an admin.
- **Assert:** both surfaces show the verification facts, the pre-install manifest, the source (repository, commit, trusted publishing, and that the tree was verified; the upload-published version says no source was verified), upload and canonical hashes, validation date, rules version, warning counts by category in the trust drawer, the "new" mark on the guard, and link the full report; the unpublished report is not found anonymously and readable by the publisher and the admin.

### IT-PAGE-003 Every file of a public pack is readable on the site
- **Covers:** REQ-SEARCH-022
- **Runs:** push, nightly (browser)
- **Action:** publish a pack with rules, two skills, a declared check, a coded check, a task and `with-html`'s files; open the Contents tab and each file.
- **Assert:** the tab lists every file grouped by part; each renders read-only with section anchors that IT-COMM-015's comments attach to; the HTML and SVG files are shown as text (IT-ABUSE-008 asserts the execution half).

### IT-PAGE-004 Rendered READMEs are sanitised with nofollow ugc links
- **Covers:** REQ-DELIV-012
- **Runs:** push
- **Action:** publish a README containing `<script>`, an `onclick` attribute, an `<iframe>`, a `javascript:` link and a normal outbound link.
- **Assert:** the rendered README contains none of the first four; the outbound link carries `rel="nofollow ugc"`.

### IT-PAGE-005 The dashboard shows per-pack status and the Needs-you queue
- **Covers:** REQ-TELEM-005
- **Runs:** push
- **Setup:** a publisher with: a live pack (stars, fetches, one open issue), a pack mid-validation, a version awaiting approval, a failed validation, a domain proof expiring in 5 days, an open security report, a pending Verified Publisher application; a second publisher with no packs.
- **Action:** read both dashboards.
- **Assert:** each pack shows visibility, newest version, one of Live / Working / Needs you, stars, fetches and open issues; the "Needs you" list holds exactly the approval, the failed validation, the expiring proof, the security report and the pending application, and nothing about payment; the empty dashboard shows the New pack action and nothing else.

## Not covered by an integration test

(none in this area)
