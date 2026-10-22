# PackServer UI Sitemap

Information architecture for the PackServer registry website. PackServer serves Claudinite packs; vocabulary and pack anatomy follow `/mnt/project-files/claudinite/claudinite-primer.md`. Page IDs below are the canonical anchors used by the wireframes (`docs/ui/wireframes.html`, `docs/ui/wireframes-v2.html`) and by `flows.md`.

## Roles

Site roles, by what the site lets them do. A Claudinite *member* is a repo running Claudinite; this document uses *signed-in user* (or *account*) for a person with a session, and "member" only for repos (see open decision 18).

| Role | Who | Can do |
|---|---|---|
| **Anonymous visitor** | Anyone, incl. crawlers and Claude Code sessions over MCP | Browse, search, filter, read pack pages, read reviews/issues, read MCP docs, call public MCP tools |
| **Signed-in user** | Signed-in individual (passkey or GitHub; email code for sign-up and recovery only) | Everything above + star, rate (1-5), write reviews, file bug reports and private security reports, manage profile, MFA (optional), sessions, personal read tokens |
| **Publisher** | Signed-in user who has enrolled as publisher (MFA required, payment method on file) | Everything above + publish/revoke versions, see validation reports, connect GitHub auto-publish, create orgs, verify domains/GitHub orgs, manage private-pack access, billing |
| **Org roles** (within a Publisher org) | `owner` / `maintainer` | Owner: all org actions incl. org members, billing, transfer, delete. Maintainer: publish/revoke versions, edit listing, manage access lists; no billing/org members/transfer |
| **Moderator** (internal) | PackServer staff | Act on abuse reports: hide/remove packs, suspend accounts, revoke verifications (admin UI is out of scope for v1 wireframes) |

### Personas

Who each role serves (primer §Personas). Anonymous and signed-in users are Claudinite's buyers, each with a trust demand: Marcus (platform engineer, 300 engineers; org allow list and internal mirror), Dana (engineering manager), Jordan (startup CTO), Grace (agency owner, client repos), Elena (indie, 15 repos), Sam (AppSec approver; a pre-adoption manifest of what a pack does to a repo, signed versions, a soak before `stable`). Publishers are Rafael (OSS maintainer; publishes only if the format is open and OSS publishing is free) and Carmen (publishes her company's packs).

Pattern sources: npm (user vs. publisher with 2FA levels), PyPI (trusted publishing, org roles), crates.io (owners vs. team owners), Docker Hub (org roles), JFrog Artifactory (permission targets per repo/path).

## Sitemap tree

```
/                                  home
├── /browse                        browse (search results + filters)
├── /packs/{publisher}/{pack}      pack
│   ├── ?tab=overview              pack.overview
│   ├── ?tab=contents              pack.contents
│   ├── ?tab=versions              pack.versions
│   ├── ?tab=reviews               pack.reviews
│   └── ?tab=issues                pack.issues
├── /@{publisher}                  publisher (user or org profile)
├── /claude-code                   claude-code ("For Claude Code": MCP endpoint docs)
├── /signin                        signin (sign in / sign up)
│
├── /account                       account  [signed-in]
│   ├── /account/mfa               mfa      [signed-in]
│   ├── /account/stars
│   ├── /account/reviews
│   ├── /account/reports
│   ├── /account/security          (MFA, sessions, API tokens)
│   └── /account/tokens
├── /packs/{p}/{pack}/review       review   [signed-in]
├── /packs/{p}/{pack}/report       report   [signed-in]
│
├── /dashboard                     dashboard  [publisher]
├── /publish                       publish (wizard)  [publisher]
│   ├── /publish/source            step 1
│   ├── /publish/validate          step 2
│   ├── /publish/listing           step 3
│   ├── /publish/visibility        step 4
│   ├── /publish/pay               step 5
│   └── /publish/done              step 6
├── /validation/{run_id}           validation (report)  [publisher]
├── /dashboard/github              github (auto-publish config)  [publisher]
├── /orgs/{org}/settings           org  [publisher, org owner/maintainer]
├── /packs/{p}/{pack}/access       access (private pack access)  [publisher]
└── /billing                       billing  [publisher]
```

```mermaid
flowchart TD
  home["home"] --> browse["browse"]
  home --> pack["pack"]
  home --> claudecode["claude-code"]
  home --> signin["signin"]
  browse --> pack
  pack --> publisher["publisher"]
  pack --> review["review (signed-in)"]
  pack --> report["report (signed-in)"]
  pack --> access["access (publisher)"]
  signin --> mfa["mfa (signed-in)"]
  signin --> account["account (signed-in)"]
  account --> mfa
  account --> dashboard["dashboard (publisher)"]
  dashboard --> publish["publish wizard (publisher)"]
  publish --> validation["validation (publisher)"]
  dashboard --> validation
  dashboard --> github["github (publisher)"]
  dashboard --> org["org (publisher)"]
  dashboard --> billing["billing (publisher)"]
  publish --> billing
  dashboard --> access
```

## Page-by-page

| ID | URL | Purpose | Role | Key components | Key actions |
|---|---|---|---|---|---|
| `home` | `/` | Entry point: search, discovery; the pitch leads with checks ("the Stripe pack exists and I can pin it") | Anon+ | Hero search box; category grid (e.g. Cloud, Data, Testing, Security, Docs, DevOps); Recently stable / Verified publishers rails (a "Trending" rail is open decision 15); "For Claude Code" panel with the MCP endpoint URL and the one-line adoption (`cn adopt <id>`, lands as a PR); footer | Search, pick category, open pack, open `claude-code`, sign in |
| `browse` | `/browse?q=&category=&feature=&verified=&repo=&channel=&sort=` | Search results | Anon+ | Left filter rail: category (multi), contains pack content type (rules / skills / checks / guards / tasks), "checks only (no tasks, no skills)", channel: stable, verified publisher toggle, has public repo toggle; sort: relevance / age / publisher tier; result cards (name, publisher + badge, one-liner, manifest line "4 checks · 1 guard · 4 tasks (monthly) · 6 skills", channel, publisher tier, updated); pagination | Filter, sort, open pack. URL is the state (crates.io / npm pattern) |
| `pack` | `/packs/{publisher}/{pack}` | Pack detail | Anon+ (actions gated) | Header: name, publisher + verified badge, newest stable version + channel + visibility chip, star button + count, rating stars + count (rating display is open decision 15); **Manifest of effects** (above the README): guards added, tool calls guarded, tasks and cadence, forced skills, GitHub actions requested, `minEngineVersion`, `requires`; **Adopt panel**: `cn adopt <id>` and the Claudinite settings declaration (`packs.declared`, with optional `version:` freeze), muted line "Lands as a pull request; updates arrive the same way" (copy); **Repo link** or prominent **"No public repo"** badge; **Contents summary** by pack content type with counts (rules, skills, declared / coded checks, guards, tasks); **Validation status** chip (passed / warnings) linking to public summary; tabs: Overview (README), Contents (tree by content type, each with name + description; every file readable), Versions (list, channel, revoked marker, sha256, minEngineVersion, requires, changelog), Reviews (rating histogram + reviews), Issues (bug reports, severity, status) | Star, rate/review (-> `review`), report (-> `report`), copy adopt snippet, switch version, publisher-only: Manage menu (edit listing, access, revoke, new version) |
| `publisher` | `/@{handle}` | User or org public profile | Anon+ | Avatar, display name, handle, verified badge with list of verified domains / GitHub org; publishing since; pack list with status; links | Open packs, (owner) edit profile |
| `claude-code` | `/claude-code` | "For Claude Code": MCP endpoint docs | Anon+ | Endpoint URL; tool reference: `search_packs`, `get_pack`, `list_categories`, `get_pack_manifest`, `fetch_pack`; how a session uses them (discover and inspect, then propose `cn adopt <id>`, which lands a PR; nothing is fetched at session time); auth section (public = none, private = a read token used by the repo's update task and `cn adopt` via `packs.sources`, see open decision 17); example transcripts; MCP client config snippet; rate limits | Copy config, create read token (-> `account`) |
| `signin` | `/signin` | Sign in or sign up | Anon | Buttons: Sign in with a passkey (default), Sign in with GitHub; email one-time code for sign-up and "Lost your passkey?" recovery only; "What you get" blurb; after first login: handle + display name step | Sign in, sign up, continue to `mfa` if required |
| `mfa` | `/account/mfa` | MFA enrollment & management | Signed-in | Passkey (WebAuthn) primary; TOTP fallback with QR + manual key; recovery codes (download/print once); list of enrolled factors with last-used; "MFA required for publishers" banner | Add passkey, add TOTP, regenerate recovery codes, remove factor (confirm with passkey) |
| `review` | `/packs/{p}/{pack}/review` | Rate + write review | Signed-in | Version selector (defaults to newest stable); 1-5 star input (open decision 15); title; body (markdown); edit existing review notice | Submit, edit, delete own review |
| `report` | `/packs/{p}/{pack}/report` | File bug report | Signed-in | Version selector; severity (low / medium / high / critical); type (bug / docs / security); repro steps; environment; attachments; **Private security report** toggle (not public, goes to publisher security contact + PackServer); "Report abuse instead" link | Submit; see on `account` > My reports |
| `account` | `/account` | Account settings | Signed-in | Tabs: Profile (avatar, handle, display name, bio, links), Starred packs, My reviews, My reports, Security (MFA status -> `mfa`, active sessions w/ revoke, API tokens: name, scopes `read:private`, expiry, last used), Become a publisher CTA | Edit profile, revoke session, create/revoke token (confirm with passkey), delete account |
| `dashboard` | `/dashboard` | Publisher home | Publisher | Context switcher (personal / each org); alerts strip (failed validations, pending payments, expiring domain verification, security reports); My packs table (name, visibility, newest version, channel, status: published / draft / validating / failed / revoked, stars, member repos holding it, open issues); Drafts; Private packs section; quick links to `github`, `org`, `billing` | New pack (-> `publish`), open pack manage, resume draft |
| `publish` | `/publish` | 6-step wizard | Publisher | Stepper: 1 Source (GitHub repo + path, read from the repo (trusted publishing workflow running `cn vendor`, or the read-only GitHub App), or upload archive drag-drop with size limit; upload vs. packs-from-a-repo is open decision 14) → 2 Validate (live log, links to `validation`) → 3 Listing details (name, slug, category, tags, summary, README preview, repo link / "no public repo" confirm, icon) → 4 Visibility & price (Public $1 one-time / Private: price TBD, access model picker) → 5 Pay (Stripe Checkout redirect, or "payment method on file" one-click) → 6 Publish to `staging` (confirm with passkey); `stable` after the soak (open decision 16) | Next/back, save draft, cancel |
| `validation` | `/validation/{run_id}` | Validation report | Publisher (public summary visible on `pack`) | Overall verdict (pass / warn / fail); check list with status + expandable detail: schema, manifest (version format `1.YMMDD.n`, `minEngineVersion`, `requires`), effects manifest (derived), security scan, SDK-only imports, secret scan, prompt-injection heuristics on `RULES.md` and `SKILL.md`, test run (logs), size limits, license; duration; "Re-run" / "Resubmit" buttons; link to source commit/archive hash | Re-run, resubmit, download log |
| `github` | `/dashboard/github` | GitHub auto-publish config | Publisher | Trusted publishers and (optional) read-only GitHub App repos; per-pack row: repo, path (e.g. `packs/gcp/`), trigger (tag = version, e.g. `1.61021.1`, or release), trusted publishing config (owner, repo, workflow file, environment) in PyPI style; recent runs with PackServer status (nothing is written back to GitHub); "Copy workflow YAML" (runs `cn vendor` before upload) | Connect repo, add/edit mapping, disable, view run |
| `org` | `/orgs/{org}/settings` | Org management | Publisher (owner/maintainer) | Tabs: General (name, handle, avatar); Verification (domain via DNS TXT with record shown + "Check now"; GitHub org via read-only App install or GitHub sign-in as org admin); Org members (list with role, invite by handle/email, pending invites); Security (require MFA for all org members: on by default); Danger (transfer packs, delete org) | Create org, verify, invite, change role, remove |
| `access` | `/packs/{p}/{pack}/access` | Private pack access (OPTIONS, not decided) | Publisher (owner/maintainer) | Visibility chip; access model panel with the 2-3 options below; audit log of grants/fetches | Grant/revoke per chosen model, change visibility (confirm with passkey) |
| `billing` | `/billing` | Payments | Publisher | Plan (Free publisher / Private packs plan TBD); payment method via Stripe (customer portal link); receipts table (date, item, pack, amount, invoice PDF); upcoming charges | Update card, download receipt, cancel plan |

## Navigation / header states

| State | Left | Center | Right |
|---|---|---|---|
| Anonymous | Logo | Search box | `Browse` · `For Claude Code` · **Sign in** button |
| Signed-in | Logo | Search box | `Browse` · `For Claude Code` · `Become a publisher` · avatar menu: Account, Starred, My reviews, My reports, Security, Sign out |
| Publisher | Logo | Search box | `Browse` · `For Claude Code` · **New pack** (primary) · avatar menu: Dashboard, Account, Billing, Orgs (list), Security, Sign out |
| Publisher inside dashboard pages | Logo + context switcher (personal / org) | Search box | same as Publisher; secondary sidebar: Packs, Drafts, GitHub, Org settings, Access, Billing |

Mobile: hamburger with the same items; search collapses to icon. Alert badge on avatar when `dashboard` has alerts.

## Permission matrix

Legend: ✓ allowed · S = allowed, each time confirmed with a passkey tap bound to that action (fresh TOTP code for TOTP-only accounts) · ✗ not allowed · (own) = only own items

| Action | Anon | Signed-in | Publisher (personal) | Org maintainer | Org owner |
|---|---|---|---|---|---|
| Browse / search / read public pack | ✓ | ✓ | ✓ | ✓ | ✓ |
| Call public MCP tools | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read private pack | ✗ | granted only | own | org's | org's |
| Star | ✗ | ✓ | ✓ | ✓ | ✓ |
| Rate / review | ✗ | ✓ | ✓ (not own packs) | ✓ (not org packs) | ✓ (not org packs) |
| Edit / delete review | ✗ | own | own | own | own |
| File bug report / private security report | ✗ | ✓ | ✓ | ✓ | ✓ |
| Report abuse | ✓ (captcha) | ✓ | ✓ | ✓ | ✓ |
| Manage MFA / sessions | ✗ | S | S | S | S |
| Create read token (`read:private`) | ✗ | S | S | S | S |
| Enroll as publisher (MFA + payment method) | ✗ | S | — | — | — |
| Create pack / publish version | ✗ | ✗ | S | S | S |
| Edit listing details | ✗ | ✗ | own | ✓ | ✓ |
| Revoke version | ✗ | ✗ | S | S | S |
| Change visibility (public ↔ private) | ✗ | ✗ | S | ✗ | S |
| Manage private-pack access grants | ✗ | ✗ | own | ✓ | ✓ |
| Configure GitHub auto-publish | ✗ | ✗ | own | ✓ | ✓ |
| Respond to bug reports / close issues | ✗ | ✗ | own | ✓ | ✓ |
| Create org | ✗ | ✗ | S | — | — |
| Verify domain / GitHub org | ✗ | ✗ | — | ✗ | S |
| Invite / remove org members, change roles | ✗ | ✗ | — | ✗ | S |
| Transfer pack ownership | ✗ | ✗ | S | ✗ | S |
| Billing / payment method / receipts | ✗ | ✗ | own | ✗ | ✓ |
| Delete org / delete pack | ✗ | ✗ | S (own pack) | ✗ | S |

Note: publishing a public pack is a one-way "public forever" promise for already-vendored versions: a public version can be revoked (never selected by an update) but the archive stays retrievable by exact version, since member repos already vendor it. Taking a pack private after being public only affects future versions.

## Private pack access: options (not decided)

The engine's private path today is a `packs.sources` entry (a CDN base or a repo's `vendored` branch) read by `cn adopt` and the scheduled update task in Actions; whether PackServer serves private packs as a `packs.sources` host or steps aside for "packs from a repo" is open decision 17. The options below describe who may read; in every option the reader is a repo's update task or `cn adopt`, not a session-time fetch.

| Option | How it works | Pros | Cons | Sources |
|---|---|---|---|---|
| A. Org members / teams | Anyone with a role in the owning org (or named team) can read. The repo's update task and `cn adopt` use a read token in `packs.sources`. | Simplest mental model; mirrors npm private packages / Docker Hub private repos | Requires everyone to be in the org; no fine-grained external sharing | npm orgs, Docker Hub, GitHub Packages |
| B. Named users / orgs allow-list | Pack has an allow-list of handles and orgs; invitees accept. | Works across orgs (Google shares with a partner) | Allow-list management burden; invitation spam vector | crates.io does not do this; Artifactory permission targets; Google Drive-style sharing |
| C. Scoped read tokens for repos | Publisher mints tokens scoped to `read:pack/{id}` with expiry and optional IP/CIDR; distributed out-of-band into CI secrets; the update task sends them to the pack source. | Best fit for a fleet manager mirroring a private pack for its members (`packs.sources`, engine design §Pack sources); no PackServer account needed for the consumer | Secret distribution and rotation on the publisher; audit by token not by person | PyPI/npm granular tokens, Artifactory access tokens, Cloudflare API tokens |
| D. Gated access requests | Pack page shows "Request access"; requester fills a form (name, org, intended use, accept terms). Owner approves or denies, or turns on auto-approve. A grant/revoke API lets a Stripe webhook approve paid access. | Works for strangers without pre-knowing them; natural fit for paid private packs; per-user grants are auditable | Owner has to triage requests; needs anti-spam on the form | Hugging Face gated repos (see `research/registry-research.md`) |

Recommended combination: A as the default, C as an add-on for CI and fleets, D for paid or partner access (it subsumes most of B), B deferred. Model the permissions underneath as resource × principal × action (JFrog permission targets) so any of these is a policy, not a redesign. Pricing for private packs TBD; the research shows per-seat pricing is the norm (npm $7, HF Team $20, PyPI orgs $5 per seat per month), and Claudinite's own plans are Personal fleet $9/account/month and Organisation fleet $99/user/month (primer).

## Open decisions

1. **Stars vs. rankings**: proposal is stars (bookmark/popularity) + 1-5 rating with written review (VS Code Marketplace / Docker Hub pattern). Alternative: stars only (crates.io / npm) or thumbs-up/down. Input from the persona study: never rank by stars or installs; a score is accepted only from verifiable facts with a published formula. See decision 15.
2. **Private pack access model**: A (org members), B (allow-list), C (scoped tokens), D (gated access requests) or combination. Decide, and decide private pricing. See decision 17.
3. **Charge timing**: proposal is charge-after-validation-passes (see `flows.md` > Payment). Alternative: charge-on-submit with refund on fail.
4. **MFA scope**: proposal is required for publishers, optional for signed-in users. Decide whether org owners must re-verify MFA for all org members (npm "enforce 2FA" style).
5. **Namespace model**: scoped `@<scope>/<pack>`, matching the backend design. A scope belongs to a user or an org; its badge states what was proven (GitHub org, domain). Names are never recycled. Scoped names remove name-squatting disputes. See decision 13.
6. **Validation gate strictness**: which checks are blocking (schema, secrets, size) vs. advisory (prompt-injection heuristics, missing tests). Proposal in `validation` page.
7. **Public validation detail**: show full report publicly vs. only verdict + check names. Proposal: verdict + check list public, logs publisher-only.
8. **Rating eligibility**: anyone signed-in vs. only accounts whose repos hold the pack. Proposal: any signed-in user, with "verified adoption" badge on reviews from accounts whose repos fetched the pack.
9. **Review moderation**: publisher reply only vs. publisher can flag; proposal: reply + flag, never delete.
10. **Anonymous abuse reports**: allow with captcha vs. require sign-in. Proposal: allow with captcha (Turnstile).
11. **Category taxonomy**: fixed curated list vs. free tags. Proposal: fixed top-level categories + free tags.
12. **Org verification method** (settled by the backend design): GitHub org proof (read-only App install or GitHub sign-in as org admin) and domain proof (DNS TXT or `.well-known` file) each give their own badge; Verified Publisher needs both plus scope-wide MFA and manual review.

Raised by the Claudinite alignment review (`/mnt/project-files/claudinite/reviews/ui.md`, owner decisions D1–D7); open, not rewritten here:

13. **Pack ids: `@scope/name` vs bare ids** (review D1). The backend design and every UI file use `@google/gcp-ops`; the engine's declarations, index layout (`packs/<id>/…`), check-id prefixes and `cn adopt ID[,ID]` use bare ids, and the shelf must reserve `fleet`. Either the engine learns scoped ids, or PackServer maps a scope to a bare id (`google-gcp-ops`) and the UI shows both. The adopt line on every pack page depends on this.
14. **Who publishes, and from where** (review D2). Today only the packs repo's release workflow publishes, and an organisation's own packs come *from a repo* it controls. The wizard's "upload an archive" path produces packs with no `sourceCommit` and no reviewable source. Decide whether upload-only packs exist at all, or whether every pack must come from a repo with upload reserved for private packs.
15. **Reputation signals: stars, 1-5 ratings, "Trending", fetch counts, pack score** (review D3). The personas say install and star counts are ignored, freshness is a risk signal, and a score is accepted only from verifiable facts with a published formula. Decide which of these stay and, if the score stays, that its formula is published beside it. Section-level comments and votes in the reader are not in question.
16. **Channels and soak in the publish flow** (review D5). The engine has `staging` and `stable` and the personas want a soak. Decide the soak length (Claudinite's own shelf uses 48 h; Dependabot 72 h) and whether promotion to `stable` is automatic after the soak or a second passkey action; the Status mark, the Versions tab and flow 6 change with it.
17. **Private packs and `packs.sources`** (review D6). The engine's private path is a `packs.sources` entry read by `cn adopt` and the update task in Actions with the repo's GitHub access. Decide whether PackServer private packs are served as a `packs.sources` host (token in CI secrets) or as "packs from a repo" (no PackServer involvement), before the access page is designed further.
18. **The word "member"** (review D7). Claudinite uses it for a repo running Claudinite, and PackServer's own copy needs that sense ("member repos holding this pack"). These documents now say *signed-in user* / *account* for a person; confirm, and align the wireframes.
19. **Brand** (review D4). Neither wireframe uses Claudinite's pentagonal crystal glyph or its paper/ink/malachite tokens. Is PackServer presented as Claudinite's shelf (glyph, tokens, "Claude Code only" admission on the site) or as a separate product that serves Claudinite packs?
