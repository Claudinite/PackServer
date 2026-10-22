# Sitemap

Pages, roles and the permission matrix. Flows: [flows.md](flows.md). Principles:
[design-principles.md](design-principles.md).

## Roles

| Role | Can |
|---|---|
| Anonymous visitor (people and agents over MCP) | Browse, search, read packs, reviews, issues and contents; call public MCP tools |
| Signed-in | Star, rate and review, comment and vote on sections, file bug and security reports, report abuse, manage profile, MFA and sessions |
| Publisher (signed-in with MFA) | Publish and yank, read reports, configure trusted publishing, create orgs, prove domains and GitHub orgs, manage allowlists, billing |
| Org owner / maintainer | Owner: everything for the org including members, billing, transfer, delete. Maintainer: publish, yank, edit listing, manage grants |
| Admin | The admin app ([../requirements/admin.md](../requirements/admin.md)) |

## Tree

```
/                                   home: search, categories, Recently published, Trending, footer line for agents
├── /browse                         results, filters, sort; URL is the state
├── /packs/@{scope}/{name}          pack: overview (README) · contents · versions · reviews · issues
├── /@{scope}                       publisher profile
├── /claude-code                    MCP endpoint docs and client config
├── /signin
├── /account                        profile · stars · reviews · reports · security (MFA, sessions, tokens)
├── /packs/@{scope}/{name}/review   rate and review
├── /packs/@{scope}/{name}/report   bug or private security report; link to report abuse
├── /dashboard                      publisher home: Needs you, packs, drafts, private packs
├── /publish                        wizard: source → validate → listing → visibility → pay → publish
├── /validation/{run_id}            report (publisher until published, then public)
├── /dashboard/github               trusted publishers and App repositories
├── /orgs/{org}/settings            general · verification · members · security · danger
├── /packs/@{scope}/{name}/access   allowlist, fetches by account and repository, denied attempts
└── /billing                        credits, plan, Polar customer portal, orders
```

## Pages

| Page | Primary elements | Actions |
|---|---|---|
| home | Search box; category grid; Recently published and Trending rails; a muted footer line pointing agents to `/mcp` | Search, open pack, sign in |
| browse | Results as cards (design budget); one row of filter toggles: category, part, Verified publisher, has repository; sort (score default, stars, rating, recent, fetches) | Filter, sort, open |
| pack | Name and pitch; publisher mark with source; pre-install manifest line; adopt block; repository link or "No public repo"; score; shape glyph; rating; Pulse; tabs | Star, review, report, comment on a section, copy adopt snippet, switch version; publisher: manage menu |
| pack › contents | Every file by part, each rendered read-only with section anchors and collapsed comments | Comment, vote |
| pack › versions | Each version: number, `published_at`, status, sha256, `minEngineVersion`, `requires`, score, manifest widening marker | Open report, open attestation |
| publisher | Handle, proofs, Verified Publisher mark, packs | Open packs |
| claude-code | Endpoint URL; tools `search_packs`, `list_categories`, `get_pack`, `get_download`; how a session uses them and proposes `cn adopt`; private packs over MCP after OAuth sign-in or with a `psr_` read token (REQ-SEARCH-009 to 011), and in CI with the Actions OIDC token; client config; rate limits | Copy config |
| signin | Passkey (default), GitHub; email code for sign-up and recovery only; handle step on first login | Sign in, sign up |
| account › security | Factors with last used, recovery-code reminder, sessions with revoke, tokens with last used, security history | Add or remove factor, revoke, mint token (passkey) |
| dashboard | Needs-you queue; packs with status, newest version, fetches, declaring repos, open issues; drafts; private packs | New pack, approve, resume draft |
| publish | One step per screen: source (GitHub repository and path, or upload marked "No public repo") → validate (live log) → listing (category, tags, repository) → visibility (public, private) → pay (one credit; buy a bundle; skipped for Verified Publishers) → publish (passkey) | Next, back, save draft |
| validation | One-sentence verdict; "Show report" list of findings with file, line, rule, hint, and for a prose-screen hold the quoted passage, never a probability or threshold; previous runs; re-run and dry-run, both rate-limited | Re-run, resubmit, download log |
| github | Per pack: repository, path, trigger, trusted publisher (owner, repository, workflow, environment); recent runs with in-site status; copy workflow YAML | Add, edit, disable |
| org settings | Name and handle; domain proof (record shown, Check now) and GitHub org proof; members and roles; require MFA or passkeys only; transfer and delete | Prove, invite, change role |
| access | Visibility; allowlist of GitHub accounts with added-by and last fetch; fetches by account and repository; denied attempts | Add or remove (passkey), change visibility (passkey) |
| billing | Credits left; plan (credits, Team seats, Verified Publisher); Polar customer portal; orders | Buy bundle, manage in Polar |

Header: anonymous shows Browse and Sign in; signed-in adds the avatar menu; publishers get New pack
and the dashboard context switcher. Mobile collapses to a menu and a search icon.

## Permission matrix

S = allowed with a per-action assertion.

| Action | Anon | Signed-in | Publisher | Org maintainer | Org owner |
|---|---|---|---|---|---|
| Browse, search, read public packs, public MCP tools | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read private pack | ✗ | allowlisted only | own | org's | org's |
| Star, review, comment, vote, report bug or abuse | ✗ | ✓ | ✓ (not own) | ✓ (not org's) | ✓ (not org's) |
| Manage MFA, sessions, tokens | ✗ | S | S | S | S |
| Publish, yank, approve staged | ✗ | ✗ | S | S | S |
| Edit listing, manage grants, configure trusted publishing, answer reports | ✗ | ✗ | own | ✓ | ✓ |
| Change visibility, transfer, delete pack | ✗ | ✗ | S | ✗ | S |
| Create org | ✗ | ✗ | S | — | — |
| Prove domain or GitHub org, manage members, billing, delete org | ✗ | ✗ | — | ✗ | S |
