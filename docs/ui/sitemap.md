# Sitemap

Pages, roles and the permission matrix. Flows: [flows.md](flows.md). Principles:
[design-principles.md](design-principles.md).

## Roles

| Role | Can |
|---|---|
| Anonymous visitor (people and agents over MCP) | Browse, search, read packs, reviews, issues and contents; call public MCP tools |
| Signed-in | Star, rate and review, comment and vote on sections, file bug and security reports, report abuse, manage profile, MFA and sessions |
| Publisher (signed-in with a passkey) | Publish and yank, read reports, configure trusted publishing, create orgs, prove domains and GitHub orgs, apply for Verified Publisher, manage allowlists |
| Org owner / maintainer | Owner: everything for the org including its people, transfer, delete. Maintainer: publish, yank, edit listing, manage grants |
| Admin | The admin app ([../requirements/admin.md](../requirements/admin.md)) |

## Tree

```
/                                   home: search, categories, Recently published; Trending once a pack qualifies
├── /browse                         results, filters, sort; URL is the state
├── /packs/@{scope}/{name}          pack: overview (README) · contents · versions · reviews · issues
├── /@{scope}                       publisher profile
├── /claude-code                    MCP endpoint docs and client config
├── /rules                          every validation rule: id, class, one line (REQ-VAL-024)
├── /pricing                        what things would cost, struck through, "free through 2026"
├── /signin
├── /account                        profile · stars · reviews · reports · security (passkeys, recovery codes, sessions, tokens)
├── /packs/@{scope}/{name}/review   rate and review
├── /packs/@{scope}/{name}/report   bug or private security report; link to report abuse
├── /dashboard                      publisher home: Needs you, packs, drafts, private packs
├── /publish                        wizard: source → check → listing → visibility → publish
├── /validation/{run_id}            report (publisher until published, then public)
├── /dashboard/github               trusted publishers
├── /orgs/{org}/settings            general · verification · people · security · danger
└── /packs/@{scope}/{name}/access   allowlist, fetches by account and repository, denied attempts
```

An unknown or private pack, scope or path answers one not-found page with the search box and a
"Sign in" link (REQ-PRIV-001).

## Pages

| Page | Primary elements | Actions |
|---|---|---|
| home | Search box; category grid; Recently published rail; a muted footer line pointing agents to `/mcp`; Trending appears as a fourth element only once a pack qualifies (REQ-COMM-014) | Search, open pack, sign in |
| browse | Results as cards (design budget); one row of filter toggles: category, part, Verified publisher, has repository; sort (score default, stars, rating, recent, fetches); the verified-domains filter is a text field in the filter row's "more" disclosure | Filter, sort, open |
| pack | Name and pitch; publisher mark with proof; pre-install manifest line; adopt block; status line when it applies; one gesture away: newest version with `published_at`, repository link or "No public repo", score, shape glyph, rating, Pulse, tabs | Star, review, report, comment on a section, copy adopt snippet, switch version; publisher: manage menu |
| pack › contents | Every file by part, each rendered read-only with section anchors and collapsed comments | Comment, vote |
| pack › versions | Each version: number, `published_at`, status, sha256, `minEngineVersion`, `requires`, score, manifest widening marker, source verified or not | Open report, open attestation |
| publisher | Handle, proofs with dates, packs; "Verified Publisher" in the mark's hover | Open packs |
| claude-code | Endpoint URL; tools `search_packs`, `list_categories`, `get_pack`, `get_download`, `list_my_packs`, `star_pack` and which need sign-in; how a session uses them and proposes `cn adopt`; private packs over MCP after OAuth sign-in or with a `psr_` read token (REQ-SEARCH-009 to 011), and in CI with the Actions OIDC token; client config; rate limits | Copy config |
| rules | The rule list by class with the rules version | Search |
| pricing | New pack ~~$1~~, Verified Publisher ~~$99 a year~~, Team ~~per seat~~, each "free through 2026"; what each would buy | Apply for Verified Publisher |
| signin | Passkey (default), GitHub; handle step on first login | Sign in, sign up |
| account › security | Passkeys with last used, recovery-code reminder, sessions with revoke, read tokens with last used, security history | Add or remove passkey (sensitive after the first), revoke, mint read token (passkey) |
| dashboard | Needs-you queue; packs with status, newest version, fetches, declaring repos, open issues; drafts; private packs; with no packs, the New pack action alone | New pack, approve, resume draft |
| publish | One step per screen: source (GitHub repository and path, or upload marked "No public repo") → check (the dry-run's live log) → listing (category, tags, repository) → visibility (public, private) → publish (passkey) | Next, back, save draft |
| validation | One-sentence verdict; "Show report" list of findings with file, line, rule, hint, and for a prose-screen hold the quoted passage, never a probability or threshold; previous runs; re-run and dry-run, both rate-limited | Re-run, resubmit, download log |
| github | Per pack: repository, path, workflow, ref pattern, events, environment; recent runs with in-site status; copy workflow YAML (Action pinned by SHA) | Add, edit, switch trusted-publishing-only (REQ-PUB-008) |
| org settings | Name and handle; domain proof (record shown, Check now) and GitHub org proof; Verified Publisher application and its state; owners and maintainers; require MFA or passkeys only; transfer and delete | Prove, apply, add a person, change role |
| access | Visibility; allowlist of GitHub accounts with added-by, "private repositories only" and last fetch; fetches by account and repository; denied attempts | Add or remove (passkey), change visibility (passkey) |

Header: anonymous shows Browse and Sign in; signed-in adds the avatar menu; publishers get New pack
and the dashboard context switcher. Mobile collapses to a menu and a search icon.

## Permission matrix

S = allowed with a per-action assertion.

| Action | Anon | Signed-in | Publisher | Org maintainer | Org owner |
|---|---|---|---|---|---|
| Browse, search, read public packs, public MCP tools | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read private pack | ✗ | allowlisted only | own | org's | org's |
| Star, review, comment, vote, report bug or abuse | ✗ | ✓ | ✓ (not own) | ✓ (not org's) | ✓ (not org's) |
| Manage passkeys, sessions, tokens | ✗ | S | S | S | S |
| Publish, yank, approve awaiting or widening | ✗ | ✗ | S | S | S |
| Edit listing, manage grants, configure trusted publishing, answer reports | ✗ | ✗ | own | ✓ | ✓ |
| Change visibility, transfer, delete pack | ✗ | ✗ | S | ✗ | S |
| Create org | ✗ | ✗ | S | — | — |
| Prove domain or GitHub org, apply for Verified Publisher, manage people, delete org | ✗ | ✗ | — | ✗ | S |
