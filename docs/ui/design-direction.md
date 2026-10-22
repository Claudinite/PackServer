# PackServer UI v2: design direction

Response to the review of `wireframes.html` v1 ("very busy; fewer notifications and colored boxes; bottom-line
assessments; graphic elements; details on hover/click; let people focus on few things").

v1 in numbers: 77 status pills, 14 chips, a 5-link alert strip, 7 per-pack counts on every card, three
"trust"/"verification" panels of key-value facts, two badges per card. Almost all of it is *evidence*; almost
none of it is a *verdict*. v2 inverts that: show the verdict, keep the evidence one gesture away.

## 1. Principles and budgets

1. **Verdict first, evidence second.** Every object (pack, version, publisher, review, validation run) gets one
   bottom-line signal. Facts that feed it are never shown by default; they are the hover/click layer.
2. **Three things per view.** A screen's default state leads with at most three primary elements
   (e.g. pack page: name+summary, Trust mark, the manifest of what adopting the pack adds, then the Adopt
   block). Everything else is secondary type, behind a disclosure, or gone.
3. **Color means something or is absent.** Budget: one accent (interactive only) + a three-step semantic scale
   that appears *only* inside the Trust and Status marks. No colored pills, no colored boxes, no tinted panels.
   ~95% of pixels neutral (Things 3 rule).
4. **One alert per screen, and only if the viewer must act.** No alert strips, no counters-as-badges, no
   "receipt available" notices. Informational events live in the activity log, which is a plain list.
5. **Card budget: name, publisher mark, one line of summary, Trust mark, shape glyph, rating number.** Six
   atoms, two of them graphic. Nothing else on a card.
6. **Hover tells, click opens.** Hover = a tooltip-sized breakdown (≤5 lines, no actions). Click = a drawer or
   sheet with the full record and actions. Never a navigation to a page just to see a breakdown.
7. **Structure felt, not seen** (Linear). Group with spacing and one weight of hairline; no nested boxes,
   no panel headings in caps, no borders around sidebars.
8. **Glanceable, then data-dense** (Tufte via ONS). Where numbers appear, they come with a word-sized graphic
   (sparkline, distribution strip, segment bar) rather than a second number.

## 2. Bottom-line signals

Each signal: what it encodes, states, hover, click. All marks are 16–20 px monochrome SVG line glyphs;
only the three-state marks carry semantic color.

### 2.1 Trust mark (pack / version)

- **Encodes:** validation result × publisher proof × source origin × signing, collapsed into one verdict.
- **States (3):**
  - `●` **Trusted** (green-neutral): validation passed, publisher verified (domain or GitHub org), public repo
    built from a tag via trusted publishing (OIDC), artifact signed, past its cooldown.
  - `◐` **Partial** (amber-neutral): validation passed but one or more of {verified publisher, public repo,
    trusted publishing, signature} missing; or validation passed with warnings; or still in its cooldown.
  - `○` **Unverified / failing** (gray outline; red only if validation failed or version revoked).
- **Default render:** mark + one word ("Trusted", "Partial", "Unverified", "Revoked"). On cards: mark only.
- **Hover:** four-row checklist, each row a tick/dash and ≤6 words: `✓ Validation passed · 1 warning`,
  `✓ Publisher verified (google.com)`, `✓ Built from tag 1.61021.1 via GitHub Actions`, `– Not signed`.
- **Click:** drawer "Trust" with the full validation report, SHA-256, signature, repo link, verification
  method and date, "what this does not prove". Replaces v1's Trust panel, Verification panel, Trust-signals
  panel, Validation report page content (the page remains as a deep link).

### 2.2 Shape glyph (pack contents)

- **Encodes:** the *mix* of the five Claudinite pack types, not five counts. One 48×8 px segmented bar;
  segments in fixed type order (rules, skills, checks, guards, tasks), width ∝ count, same neutral ink with
  alternating 100%/60% opacity. Empty types draw nothing. There are no commands, subagents, MCP servers or
  shell hooks in a pack; those are Claude Code plugin content.
- **Default render:** glyph + the inventory line ("RULES.md · 6 skills · 3 checks · 1 guard · 4 tasks").
- **Hover:** vertical legend with counts for non-zero types only.
- **Click:** opens the Contents tab/drawer with the file list (`RULES.md`, `skills/<name>/SKILL.md`,
  `declared-checks.json`, `checks/*.go`, `tasks/<name>/task.json`, `pack.json`).

### 2.2b Manifest of effects (pack page, above the README)

- **Encodes:** what adopting this pack *does to a repo*, derived by validation, not by the publisher: guards
  added and the tool calls they judge, scheduled tasks and their cadence, skills forced before matching edits,
  checks and whether they block after grace, and the GitHub actions the pack asks for.
- **Default render:** a few quiet lines of secondary type directly under the Trust mark, no box, no color:
  `1 guard · PreToolUse on Bash: denies gcloud run deploy to *-prod without an approved plan`,
  `4 scheduled tasks · 3 monthly, 1 quarterly; each lands as a PR`, `3 checks · 2 blocking after the
  14-day grace, 1 advisory`, `6 skills · cloud-run-deploy forced before edits to infra/**`,
  `GitHub actions · contents: write, pull-requests: write`. A pack with none of these says so in one line.
- **Hover:** the item names behind each line. **Click:** the Contents tab.

### 2.3 Rating

- **Encodes:** mean rating and sample size.
- **Default render:** one number `4.6` in tabular figures; muted `· 212` count. No star row.
- **Hover:** five-bar distribution strip (1–5) with percentages.
- **Click:** Reviews tab. If fewer than 5 ratings, render `—` and no hover.

### 2.4 Publisher mark

- **Encodes:** who stands behind this, and whether identity is proven.
- **States:** verified organization (filled seal), verified individual (outline seal), unverified (no mark).
  Name is always shown; the mark is placed after it.
- **Hover:** `Verified via google.com (DNS) · GitHub org googlecloudplatform · 14 packs`.
- **Click:** publisher page.

### 2.5 Pack Status (publisher-only)

- **Encodes:** "does this pack need me?" Replaces Published / Validating / Awaiting approval / Failed /
  Private / Draft pills. (The approval state is called "awaiting approval", never "staged".)
- **States (3):** `Live` (neutral text, no mark), `Working` (small spinner glyph: validating, building,
  re-checking), `Needs you` (filled amber dot). Private/Draft are not statuses: "Private" becomes a lock glyph
  next to the name; "Draft" sorts to the bottom in muted type.
- **Hover:** one line: `1.61020.1 awaiting approval · waiting for an Owner`, or `Validation failed · secret
  found in fixtures/`.
- **Click:** the action sheet for that version (approve with passkey, view report, retry, delete draft).

### 2.6 Needs-you queue (publisher dashboard)

- **Encodes:** every item that is blocked on the publisher, in one list, sorted by severity then age.
  Replaces the alert strip and the three KPI panels.
- **Default render:** heading "Needs you (2)" and rows: `Approve vpc-review 1.61020.1 — awaiting approval
  1 d ago  [Approve]`, `Fix bq-migrate 1.61019.1 — validation failed  [Report]`. If empty, the heading reads
  "Nothing needs you" in muted type and the section is 1 line tall.
- **Not in the queue:** receipts, domain re-check reminders > 7 days out, new reviews, fetch counts. Those go
  to the activity list or to the Billing/Org pages.

### 2.7 Pulse (activity sparkline)

- **Encodes:** 30-day fetches by member repos (a repo fetches a pack once per `cn adopt` or update PR, never
  per session) as a 64×14 px sparkline with no axes. On cards for signed-in publishers only; on the pack page
  for everyone, next to "fetched by 9.3k repos / 7 d".
- **Hover:** total, delta vs prior period. **Click:** nothing (no analytics page in v2).
- Whether a fetch count belongs on the page at all is open (§6): the personas say install counts are not a
  trust signal.

### 2.8 Severity (bug reports / validation findings)

- **Encodes:** the single worst open item. One glyph: `▲` filled for high, outline for medium, none for low.
- **Hover:** count by severity. **Click:** Issues tab filtered to open.

## 3. Information hierarchy per screen

Format: **Visible** (default) · **Hover** · **Click** · **Removed**.

### Home (anonymous)

- Visible: one sentence tagline ("Rules, checks and tasks for your repos, from the people who build the
  stack."), a search field, and one row of six pack cards ("Trending"; the rail's name and ranking are open,
  §6). That is the whole first viewport.
- Hover: card marks (Trust, shape, rating) as in §2.
- Click: "For Claude Code" and "Publish" are two plain text links under the search field, not sections.
- Removed: stat-row (1,284 packs / 312 publishers / fetches per day), "Verified publishers" section,
  "For agents" explainer block, "Publish a pack" promo panel. Hero copy reduced to one line.

### Browse / search

- Visible: query, result count, result list (cards per §1 budget). One sort control (Relevance / Age /
  Publisher tier) as text; freshness is a risk signal, age and stability are the wanted ones, so there is no
  "Updated" or "Stars" sort.
- Hover: the three marks.
- Visible: one quiet row of filter toggles under the query (Trusted only, Verified publisher, Public repo,
  Past cooldown, Contains… with the five pack types and "Checks only (no tasks, no skills)"). Outline
  pills, filled only when on; no counts, no sidebar.
  (Ariel, 2026-10-22: hiding filters in a sheet went too far; search filters stay on the page.)
- Removed: always-visible filter sidebar, "public repo / validated" pills on cards, five counts per card,
  star glyph rows, `1.61021.1` on cards (version belongs to the pack page).

### Pack page

- Visible, above the fold, in this order: `@scope/name` with publisher mark (whether ids are scoped is open,
  §6); one-line summary; Trust mark with its word; the manifest of effects (§2.2b: guards and what they
  judge, tasks and cadence, forced skills, GitHub actions); Adopt block (`cn adopt <id>` with a copy button,
  and a second copyable snippet with the Claudinite settings declaration and an optional `version:`
  freeze, under one muted line "Lands as a pull request; updates arrive the same way"); then rating number,
  shape glyph, pulse, and "Updated 2 d ago · 1.61021.1 · past cooldown · minEngineVersion 1.61006.1 · MIT" as a
  single muted line. Below: the README. Nothing is "installed": a pack is declared in settings and vendored
  into `.claudinite/shared/packs/<id>/` by `cn adopt` or the scheduled update, as a PR.
- Hover: every mark per §2.
- Click: secondary tabs rendered as plain text links in one row: Contents · Versions · Reviews · Issues.
  The Versions drawer carries cooldown state, SHA-256, `minEngineVersion` and `requires` per version, and marks a
  revoked version as such (a revoked version is never selected by an update; repos holding it keep it).
  Trust drawer from the mark. "Source" is a link inside the Trust drawer and the muted line, not a panel.
- Removed: Trust panel, "What's inside" count row (the table moves to Contents tab), repo-badge box,
  "No public repo" explanatory box (becomes the `–` row in the Trust hover), Targets/SHA/Signed/Validation
  key-value list, Star/Report/Follow as buttons in the header (Star stays as an icon button; Report and
  Follow move to a `…` menu).

### Publisher page

- Visible: name + mark, one-line description, pack list (cards).
- Hover: publisher mark breakdown.
- Click: "Verification" is a drawer from the mark.
- Removed: Verification panel, Trust-signals panel (open issues, median fix time), Follow/Report buttons
  (into `…`).

### Publisher dashboard

- Visible: Needs-you queue (§2.6); then "Packs" table with exactly four columns: name (with lock glyph if
  private), latest version, Status (§2.5), pulse sparkline. Then "Activity", a plain list of the last 10
  events in muted type with no icons.
- Hover: Status breakdown, pulse totals.
- Click: row opens the pack's manage sheet (versions, access, billing links). "Publish a pack" is the
  single accent button on the page.
- Removed: alert strip, KPI panels (fetches/stars/open issues), Source column, Stars column, Issues column,
  per-row Manage buttons, status filter dropdown (replaced by sort: Needs-you first), colored ✓/!/… icons
  in activity.

### Publish flow

- Visible: one step at a time, one question per step, a thin progress line (not numbered pills) at the top:
  Source → Check → Listing → Access → Publish. Each step shows its single input and one primary button.
  The Source step reads the pack *from a repo* ("packs from a repo" is the publishing primitive); the
  workflow snippet runs `cn vendor` so the archive is the vendored set, and publishes on tags that name a
  version (`1.YMMDD.n`). Whether an upload-only path exists at all is open (§6).
- Hover: "Why?" text links reveal one-sentence rationale inline (not a tooltip box).
- Click: "Advanced" disclosure at the bottom of Listing (tags, price) and Access (private rules).
  Payment is a sheet inside Access, shown only if a new-pack credit is needed, with one line: "First
  publish of a new pack: $X · Pay with saved card".
- Removed: auto-detected contents table (becomes the shape glyph + the manifest of effects derived by
  validation, "see Contents"), order summary box, six numbered section headers on one page, "Auto-publish
  from GitHub" as a parallel wizard (it is the Source step's second option, with a single copyable workflow
  snippet in a disclosure).

### Validation result

- Visible: one sentence verdict: "Passed with 1 warning" / "Failed: secret found in `fixtures/sa-key.json`",
  Trust mark state it produces, and one primary action (Approve with passkey / Fix and re-run).
- Hover: none.
- Click: "Show report" disclosure: findings as a plain list grouped by severity (§2.8 glyph, file path,
  one line). "What this does not prove" becomes a one-line muted sentence with a link, not a section.
- Removed: Artifact key-value panel, per-check pass pills, colored summary boxes.

### Sign-in / account

- Visible: title, one passkey button, "or continue with GitHub" as a text link. Account page: email,
  one line "Two-factor: on · 2 passkeys" with "Manage" link, "Sessions" as a plain list.
- Click: MFA setup, recovery codes, tokens each open as a sheet from their one-line row.
- Removed: Enabled/Not-enabled pills, "this device" pill (becomes italic "this device"), hint text under
  every field, Create-account marketing copy, per-section panels.

### Reader and comments

- Visible: once a version is published, every file is readable by anyone at `#read` (from "Read the pack"
  under the Adopt block, or any item in the Contents tab); the format is open and readable without the
  binary. Left: a quiet file list grouped by type: `RULES.md` and `pack.json`, `skills/<name>/SKILL.md`,
  `declared-checks.json` and `checks/*.go`, guards (Go checks in `checks/` tagged with a hook event),
  `tasks/<name>/task.json` with an optional `worker.mjs` (a select on phones). Right: the rendered file.
  Prose (`RULES.md`, `SKILL.md`) is split into sections at each heading with one muted line for size and
  token estimate; JSON and Go are shown as code with a size line only, since they never enter context.
  Nothing else; comments are **off by default**.
- Click: one text toggle in the reader header, `Comments · 7` (count for the current file), remembered per
  viewer in localStorage. When on, a section that has comments shows a small count in the right margin
  (after the heading on narrow screens); hovering or focusing a section reveals a `+` to add one (signed-in
  only; anonymous gets the sign-in sheet). Both open the section's thread in the right drawer.
- Thread: handle, age, text, and a compact `▲ n ▼` vote control with one net number; voting toggles. Sorted
  by score. Publisher replies carry a small outline `publisher` label. A `…` menu per comment: "Hide for me"
  (per-viewer, stored locally, undoable) and "Flag".
- Hiding rule: a comment whose net score is negative is shown dimmed, with a hover hint "Hidden in 2 days
  unless votes improve". Once it is 3 days old and still negative it is *strongly* hidden: collapsed to one
  muted line "1 hidden comment (low score) · Show". No colored boxes, no badges, no counts shown unless the
  viewer turned comments on.
- Pack score: not designed yet. The Trust drawer carries one muted line, "Pack score: coming soon; formula
  published with it", and nothing else changes until the measurements are defined. The personas accept a
  score only from verifiable facts with a published formula, never from installs or stars (§6).

## 4. Visual language

**Palette.** Neutral scale: paper `#FAFAF9`/ink `#17181A` (light), `#121314`/`#E8E6E1` (dark); five grays
between, warm-leaning but low chroma (Linear's note: warm, not muddy). One accent for interactive elements only:
a deep teal `#0F6E6B` (light) / `#5FC2BE` (dark). Semantic trio used *only* inside Trust/Status marks and the
severity glyph: `#2E7D4F` (trusted), `#B7791F` (partial / needs you), `#B3261E` (failed / revoked). The
accent is never used for status; status colors are never used for links or buttons.

**Typography.** One humanist sans with real tabular figures and a usable 500 weight — Source Sans 3 or
IBM Plex Sans (not Inter, not a serif). Mono (IBM Plex Mono) only for pack names, commands, hashes.
Scale: 13 / 14 (body) / 16 / 20 / 28; one display size (28) per page. Weight does hierarchy; size rarely.
No all-caps labels.

**Density and spacing.** 8-pt grid; content column max 760 px, pack page README max 680 px. Cards are not
boxes: list rows separated by 24 px of space, hairline `1px` at 8% ink only between sections. Hover on a
row raises background by one gray step; no border change.

**Graphic elements.** The marks of §2 are the only decoration. Pack icons: 28 px monochrome glyph or
initials in a neutral circle; no publisher-uploaded color logos on cards (allowed on the pack page at 48 px).
Charts: sparklines and segment bars only, single ink, no axes, no legends (legend is the hover).

**Motion.** 120 ms opacity/transform for hovers and disclosures; drawers slide 200 ms with ease-out; no
bounce, no skeleton shimmer (use a muted "Loading" word). The Working spinner is the only looping animation.

**What replaces colored boxes.** Inline sentences in muted type; a leading glyph from §2; a hairline above
a section; a drawer. The single permitted alert is a full-width one-line bar under the header, neutral
background, amber dot, one action link — shown only when the viewer must act (e.g. "Your passkey is required
to approve vpc-review 1.61020.1 · Approve").

## 5. Before → after

| v1 element | v2 treatment |
|---|---|
| Card: content counts (`3 skills · 2 checks …`, with commands / agents / MCP) | Shape glyph over the five pack types (rules, skills, checks, guards, tasks); counts on hover |
| Card: `validated` + `public repo` / `no public repo` pills | One Trust mark; rows on hover |
| Card: star row + number + ☆ count | Number only (`4.6 · 212`); distribution on hover |
| Card: version `v2.4.1` | Removed from cards; dated version (`1.61021.1`) in the muted line on the pack page |
| Home stat-row (packs / publishers / fetches per day) | Removed |
| Home "Verified publishers", "For agents", "Publish" sections | Two text links under search ("For Claude Code", "Publish") |
| Pack page Trust panel (Validation, Signed, SHA-256, Source, Targets) | Trust drawer, opened from the mark |
| Pack page "What's inside" count row + table | Manifest of effects (guards, tasks, forced skills, actions) above the README; shape glyph; table lives in Contents tab |
| Pack page Install block (`cn adopt name@version`, MCP config) | Adopt block: `cn adopt <id>` plus the settings.yaml declaration with an optional `version:` freeze |
| Versions: `yanked` / `deprecated` / `latest` | `revoked` flag from the signed index; selection is the newest version past its cooldown, there is no "latest" |
| Repo-badge box / "No public repo" explanatory box | `–` row in Trust hover; link in muted line |
| Publisher Verification + Trust-signals panels | Publisher mark hover; Verification drawer |
| Dashboard alert strip (5 links) | Needs-you queue; informational items to Activity |
| Dashboard KPI panels (fetches / stars / open issues) | Pulse sparkline per pack row |
| Dashboard status pills (6 kinds, 4 colors) | Status: Live / Working / Needs you; lock glyph for private |
| Dashboard columns Source / Stars / Issues / Manage | Removed; in the manage sheet |
| Activity list with ✓ ! … colored icons | Plain muted text list, newest first |
| Publish wizard: 6 numbered sections on one page | One step per screen, thin progress line, Advanced disclosure |
| Validation report: artifact panel + per-check pills | One-sentence verdict + "Show report" list |
| Account: Enabled / Not enabled / this device pills | One line of text per setting with Manage link |
| Browse filter sidebar | One row of toggle pills under the search box |
| `Follow`, `Report publisher`, `Report a bug` buttons in headers | `…` overflow menu; Star stays as icon |

## 6. Open decisions

PackServer replaces the engine's current repo-and-R2 pack serving, so the engine's layout, `staging` / `stable`
channels and `packs.sources` are prior art, not constraints. Still open with the owner (`sitemap.md` decisions
13–19 hold the detail):

- **Pack ids.** `@scope/name` proposed; `cn adopt` adapts to PackServer's ids.
- **Version format.** Date-based `1.YMMDD.n` proposed; the wireframes use it.
- **Cooldown length.** A new version waits out a cooldown before member repos' updates select it; the
  Status mark and the Versions tab show "in cooldown" / "past cooldown".
- **Publish from a repo vs. upload.**
- **Private access model** (options A–D) and its pricing.
- **Pre-install manifest** contents (§2.2b).
- **Reputation signals** (rating, "Trending", Pulse, pack score) and **fees**.

Settled: the site is called **Claudinite Packs**, and a person is *signed in*, never a *member* (a
Claudinite member is a repo; the prototype's internal persona value is still `member`).

## 7. References

- NN/g, Progressive disclosure — show only primary options by default; defer advanced/rare features to a
  secondary screen. https://www.nngroup.com/videos/progressive-disclosure/
- Linear, Behind the latest design refresh — "structure should be felt, not seen"; prune dividers, dim
  navigation, fewer and smaller icons, warm low-chroma grays. https://linear.app/blog/behind-the-latest-design-refresh
- Things 3 (design analysis) — ~95% neutral UI; color only when it carries meaning; details expand inline;
  shortcut hints appear on hover/focus only. https://blakecrosley.com/pt-BR/guides/design/things
- UXmatters, The hidden geometry of calm screens — calm "is not a palette": resolve priority in layout,
  consistent spacing, one focal point, size signals importance. https://www.uxmatters.com/mt/archives/2026/01/the-hidden-geometry-of-calm-screens.php
- ONS Digital, Glanceable and data-intense design (Tufte sparklines) — a glance should be enough to decide
  whether to dig; numbers need a word-sized graphic for context. https://digitalblog.ons.gov.uk/2014/12/10/glanceable-and-data-intense-design
- OpenSSF Scorecard badges — one aggregate score (x/10) on a badge, per-check detail behind it.
  https://openssf.org/?p=1757
- Socket.dev — many signals (70+ red flags) collapsed into category health scores; a single "is it a risk"
  comment in the PR, detail on separate pages. https://docs.socket.dev/docs/faq
- Chrome Web Store badges — two badges total ("Featured", "Established Publisher"), unpurchasable, each a
  single verdict over a bundle of criteria; publisher page reached by clicking the name.
  https://blog.google/products/chrome/find-great-extensions-new-chrome-web-store-badges/ and
  https://developer.chrome.com/docs/webstore/discovery
- Hugging Face model cards — metadata (tags, license, base model) parsed into a compact header; everything
  else is the README body. https://huggingface.co/docs/hub/en/model-cards
- Glama MCP directory — letter grades for license/quality/maintenance on related-server cards, "Not graded"
  as an honest state; a counter-example for ad and tab clutter. https://glama.ai/mcp/servers/jpj7dvnu1q
- Raycast Store — install is the primary action; commands, developer and metadata behind "Show Details".
  https://manual.raycast.com/v1/store
