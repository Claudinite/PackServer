# Pack pages and the pre-install manifest

Mirrors [../requirements/pack-pages-manifest.md](../requirements/pack-pages-manifest.md). Pages are
read through the server-rendered HTML in-process (a parsed DOM, no browser); `IT-PAGE-*` is the id
prefix because the page's requirements come from four areas.

### IT-PAGE-001 The pack page shows the full public summary
- **Covers:** REQ-SEARCH-014
- **Runs:** push
- **Setup:** a public pack from a Verified org (domain proof), two versions, 3 stars, rating 4.2 from 5 reviews, 120 fetches in 30 days, declared by 7 public repositories in the weekly scan, a guard and two skills, a linked repository.
- **Action:** read the page anonymously; read a second pack published by upload with no repository.
- **Assert:** the page shows the name, publisher with `verified_domain`, newest version with `published_at`, visibility, 3 stars, 4.2, 120, 7, the pre-install manifest above the README, the adopt panel (`cn adopt @scope/name`, the `packs.declared` entry, the MCP call), the repository link, the contents summary by part, the score and the validation status; the second page shows a prominent "No public repo" marker in place of the link.

### IT-PAGE-002 The public view shows verification facts, capabilities, provenance, hashes and the report
- **Covers:** REQ-VAL-042
- **Runs:** push
- **Setup:** version `1.1.0` of a pack that marked a new guard; an unpublished run of another pack.
- **Action:** read the page and `get_pack`; read the unpublished run's report anonymously, as its publisher and as an admin.
- **Assert:** both surfaces show the verification facts, the pre-install manifest, provenance, upload and canonical hashes, validation date, rules version, warning counts by category, the "new" mark on the guard, and link the full report; the unpublished report is not found anonymously and readable by the publisher and the admin.

### IT-PAGE-003 Every file of a public pack is readable on the site
- **Covers:** REQ-SEARCH-022
- **Runs:** push
- **Action:** publish a pack with rules, two skills, a declared check, a coded check, a task and `with-html`'s files; open the Contents tab and each file.
- **Assert:** the tab lists every file grouped by part; each renders read-only with section anchors; the HTML and SVG files are shown as text (IT-ABUSE-008 asserts the execution half).

### IT-PAGE-004 Rendered READMEs are sanitised with nofollow ugc links
- **Covers:** REQ-DELIV-012
- **Runs:** push
- **Action:** publish a README containing `<script>`, an `onclick` attribute, an `<iframe>`, a `javascript:` link and a normal outbound link.
- **Assert:** the rendered README contains none of the first four; the outbound link carries `rel="nofollow ugc"`.

### IT-PAGE-005 The dashboard shows per-pack status and the Needs-you queue
- **Covers:** REQ-TELEM-005
- **Runs:** push
- **Setup:** a publisher with: a live pack (stars, fetches, one open issue), a pack mid-validation, a version awaiting approval, a failed validation, a payment pending confirmation, a domain proof expiring in 5 days, an open security report.
- **Action:** read the dashboard.
- **Assert:** each pack shows visibility, newest version, one of Live / Working / Needs you, stars, fetches and open issues; the "Needs you" list holds exactly the approval, the failed validation, the pending payment, the expiring proof and the security report.

## Not covered by an integration test

(none in this area)
