# PackServer — Product research: Payments, Private access, Community, UI scheme

Date: 2026-10-21. Facts below were checked against the cited pages on this date; prices change, re-verify before launch.

---

## A) Payments

### A.1 Stripe primitives on Cloudflare Workers

| Option | What you get | Verdict for PackServer |
|---|---|---|
| **Checkout Sessions** (hosted or embedded) | Full flow: line items, Stripe Tax (`automatic_tax.enabled=true`), receipts, Link/wallets, address collection, lifecycle webhooks; sessions expire after 24h. Stripe recommends it for most integrations. | **Use this** for the $1 upload fee, credit bundles and private-pack subscriptions. Zero card data touches our Worker (PCI SAQ-A). |
| **PaymentIntents + Elements** | Lower-level; you build tax, discounts, UI and the lifecycle yourself. Tax requires a separate Tax API integration ($0.50 per Transaction call + $0.05 per Calculation call). | Only if we later want an in-page custom UI. Not for v1. |
| **Stripe Billing (subscriptions)** | Recurring charges, proration, customer portal. Created via Checkout `mode=subscription`. | Use for private-pack plans. |
| **Customer Portal** | Stripe-hosted "manage plan / update card / invoices" page. | Use it instead of building billing UI. |

Sources: [Checkout Sessions vs Payment Intents](https://edge-docs.stripe.com/payments/checkout-sessions-and-payment-intents-comparison), [Stripe Tax PAYG pricing](https://support.stripe.com/questions/understanding-stripe-tax-pay-as-you-go-pricing).

**Webhook verification on Workers.** stripe-node's `constructEvent` is synchronous and uses Node `crypto`; on Workers use `stripe.webhooks.constructEventAsync(rawBody, sigHeader, secret)` which runs on SubtleCrypto. Rules: read the body with `await request.text()` (never `.json()` first — any re-serialization breaks the HMAC); the header is `t=<ts>,v1=<hmac>`; the signed payload is `${t}.${rawBody}` under HMAC-SHA256 with the `whsec_` secret; reject if `|now - t| > 300s`; compare with a constant-time compare. Make handlers idempotent by keying on `event.id` (store processed ids in D1 with a unique index) and return 2xx fast — do the fulfillment via `ctx.waitUntil()` or a Queue. Create a Stripe SDK client with `httpClient: Stripe.createFetchHttpClient()`. Sources: [Stripe signature docs](https://docs.stripe.com/webhooks/signature.md), [Hono Stripe webhook example (uses constructEventAsync)](https://hono.dev/examples/stripe-webhook).

### A.2 The $1 anti-spam upload fee: fee impact

Stripe US standard pricing: **2.9% + $0.30** per domestic card; **+1.5%** for international cards; **+1%** currency conversion; disputes **$15**; refunds free but Stripe keeps the $0.30. Stripe's **minimum charge is $0.50 USD** (settlement-currency dependent: 0.30 GBP, 0.50 EUR, 50 JPY). Sources: [Stripe fee breakdown 2026](https://flexprice.io/blog/stripe-pricing-breakdown-2026), [Stripe minimum charge amounts](https://docs.stripe.com/currencies.md).

| Charge | Stripe fee (domestic) | Net | Fee % | Int'l card fee | Net int'l |
|---|---|---|---|---|---|
| $1.00 single upload | $0.329 | $0.671 | 32.9% | $0.344 | $0.656 |
| $2.00 | $0.358 | $1.642 | 17.9% | | |
| $5.00 (5 credits) | $0.445 | $4.555 | 8.9% | $0.52 | $4.48 |
| $10.00 (12 credits) | $0.59 | $9.41 | 5.9% | $0.74 | $9.26 |
| $20.00 (25 credits) | $0.88 | $19.12 | 4.4% | $1.18 | $18.82 |

Add Stripe Tax PAYG **0.5%** of volume where we are registered (Checkout/no-code path), i.e. half a cent on $1. A **single dispute ($15) wipes out ~22 net $1 uploads**, so the $1 fee is a deterrent, not revenue; design to minimise disputes (clear receipt descriptor "PACKSERVER UPLOAD", refund-on-request within 14 days if validation fails).

**Recommendation — "credits, charged in bundles, first one cheap":**
1. Price publishing in **publish credits**. 1 credit = one *new public pack*. Keep a $1 price point for the "I just want to publish one thing" case (we eat the 33% fee as an acquisition cost), and nudge toward bundles: 5 for $5, 12 for $10, 25 for $20. Credits never expire; non-refundable once consumed by a successful publish.
2. **Charge per new pack, not per version.** Versions of an existing pack are free (rate-limited: e.g. 20 versions/pack/day). Charging per version punishes maintenance and pushes people to publish less often — the opposite of what we want. Spam is "many packs", not "many versions". Exception: a pack that has been *unpublished or renamed* and re-created costs a new credit.
3. **Waive the fee** for publishers who have a verified org (domain-verified), or who have ≥1 pack with ≥N verified adoptions and no abuse flags, after a 30-day account age. Lets "Google publishes GCP pack" happen without the toll gate while still charging drive-by uploads.
4. **Alternative gate that costs us nothing:** instead of money, require *proof of work* equivalents for the free tier — verified GitHub account older than 90 days + passkey/MFA enrolled + Turnstile. Keep the $1 as an *optional fast lane* for new accounts. (This is what PyPI and npm do: they don't charge, they require 2FA and, increasingly, trusted publishing via OIDC. Sources: [PyPI 2FA required for all](https://blog.pypi.org/posts/2024-01-01-2fa-enforced/), [npm trusted publishing GA](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/).)
5. Implement credits as a ledger table in D1 (`credit_ledger(user_or_org_id, delta, reason, stripe_event_id UNIQUE)`); grant on `checkout.session.completed`, consume atomically with the publish transaction. Stripe also has a "billing credits / credit grants" product but our volumes don't justify it over a 20-line ledger.
6. Merchant-of-record alternatives (Paddle, Lemon Squeezy) charge **5% + $0.50** — worse at $1, but they handle global VAT/sales tax filing. Only attractive if private-pack subscriptions become the main revenue and we don't want to run tax registrations. Source: [Paddle vs Lemon Squeezy fees](https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/).

### A.3 Private pack pricing — what the market does

| Provider | Model | Price (checked 2026-10-21) |
|---|---|---|
| npm | per-seat; unlimited private packages | Pro $7/mo (individual), Teams $7/user/mo. [npm pricing](https://npmjs.com/pricing) |
| GitHub Packages | included storage + egress, per-GB overage; public free | Free 500MB/1GB, Pro & Team 2GB/10GB, Enterprise 50GB/100GB per month. [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages) |
| Docker Hub | per-seat, unlimited private repos ("fair use") | Personal $0 (1 private repo, 100 pulls/hr), Pro $9–11/mo, Team $15–16/user/mo, Business $24/user/mo. [Docker pricing](https://www.docker.com/pricing/) |
| JFrog Artifactory Cloud | platform fee + consumption (storage+transfer GB) | Pro $150/mo (promo $50) incl. 25GB; Enterprise X from $950/mo incl. 125GB; overage $1.25→$0.33/GB tiered. [JFrog pricing](https://jfrog.com/pricing/) |

Observations: packs are tiny (KBs–MBs of markdown/JSON), so storage/egress pricing (GitHub, JFrog) would produce bills of cents and is not a credible model for us; **per-seat** (npm/Docker) is the convention developers already accept. R2 has no egress fee, so our COGS per private pack ≈ 0.

**Recommended private-pack tiers:**
- **Solo** — $5/mo or $48/yr: up to 10 private packs, 1 owner, up to 5 read-only collaborators or 3 scoped read tokens.
- **Team** — $7/seat/mo (seat = anyone who can *read* private packs via web or MCP; agent read tokens don't count as seats but are capped at 5 per seat): unlimited private packs, org/team access rules, GitHub-org sync, audit log.
- **Enterprise** — custom: SSO/SAML, domain-based access, 90-day+ audit retention, SLA, invoice billing.
- Publishing a private pack never consumes publish credits (the subscription is the spam gate).
- Metering: count distinct principals who hold `packs:read` on ≥1 private pack in the billing month; bill via Stripe Billing usage records or a fixed seat count with monthly true-up.

---

## B) Private pack access control

### B.1 Options compared

| Mechanism | How | Pros | Cons |
|---|---|---|---|
| **Org/team membership** (native) | `orgs`, `teams`, `team_members`, `pack_grants(pack_id, principal_type, principal_id, role)` in D1 | Simple, auditable, what npm/Docker do | Manual roster management |
| **Per-pack allowlist** | grant to individual users/emails | Granular, works for cross-org sharing | Doesn't scale; forgotten grants |
| **Scoped read tokens** (for agents/CI) | `psr_...` tokens: SHA-256 hash stored, scopes `packs:read`, optional pack/org restriction, expiry, last-used, IP/CIDR optional | Required for headless agents and CI; revocable; no browser | Long-lived secrets leak — mitigate with expiry defaults (90d), secret scanning partner program later |
| **Invite links** | signed, single/multi-use, expiring link → grants role on accept after login | Lowest-friction onboarding | Forwardable; require login + optional email-domain restriction on accept |
| **GitHub-org/team-based** | Install our GitHub App on the org with *Organization → Members: read*; receive `organization`, `membership`, `team`, `team_add` webhooks; map GitHub team slug → pack grants; periodic reconcile via API | Zero roster duplication; most dev orgs already live in GitHub | Needs the App installed by an org owner; webhook lag; GitHub outage = stale roster (cache last-known-good) |
| **Domain-based** | "anyone with a verified @company.com email" after org domain verification (DNS TXT) | Great for large companies; what GitHub uses for "verified domain" badges | Email verification must be strong; block disposable domains; revocation on employee departure is implicit (they lose mailbox) but sessions/tokens must have short TTLs |
| **SSO/SAML/OIDC** (enterprise) | org-level IdP; JIT provisioning; SCIM later | Required by enterprise buyers | Significant build; defer |

Sources: [GitHub App permissions page](https://docs.github.com/en/enterprise-server@3.9/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) (Members permission for team events), [GitHub verified domain requirements for publisher verification](https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/applying-for-publisher-verification-for-your-organization).

### B.2 How MCP clients authenticate to see private packs

Per the MCP authorization spec (2025-11-25 revision):
- PackServer's MCP endpoint is an **OAuth 2.1 resource server**. It MUST serve **Protected Resource Metadata (RFC 9728)** at `/.well-known/oauth-protected-resource/mcp` and return `401` with `WWW-Authenticate: Bearer resource_metadata="...", scope="packs:read"`.
- The **authorization server** can be our own (co-hosted). It MUST publish RFC 8414 metadata, support **PKCE S256** (`code_challenge_methods_supported` required or clients refuse), honor the **`resource` parameter (RFC 8707)** and bind tokens to the audience `https://mcp.packserver.dev/mcp`.
- Client registration: spec now prefers **Client ID Metadata Documents (CIMD)** (client_id is an HTTPS URL to a JSON doc), with **Dynamic Client Registration (RFC 7591)** as fallback. Support both; clients like Claude Code/Desktop and Cursor will pick whichever the AS advertises.
- Anonymous access: the MCP server serves *public* pack search without a token; a `401` with scope guidance is returned only when a client asks for private content or the user calls `login`. Step-up via `403 insufficient_scope`.
- Headless agents/CI: no browser, so the OAuth flow fails. Provide **scoped read tokens** usable as `Authorization: Bearer psr_...` on the same endpoint (the resource server accepts both its own OAuth access tokens and PAT-style tokens; both are audience-restricted to the MCP endpoint — never accept GitHub or other third-party tokens, token passthrough is explicitly forbidden).
- Implementation: `@cloudflare/workers-oauth-provider` wraps a Worker with authorize/token/registration endpoints, stores tokens as hashes in KV, encrypts per-grant `props` (user id, org ids, scopes) with AES-GCM and hands them to the MCP handler as `ctx.props`; refresh tokens rotate; DCR is off by default and has a 90-day client TTL. Sources: [MCP Authorization spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [workers-oauth-provider README](https://github.com/cloudflare/workers-oauth-provider/).

### B.3 Phased recommendation

- **Phase 1 (launch):** owner + per-pack allowlist (users by handle/email) + invite links + scoped read tokens + OAuth 2.1 on MCP for the *logged-in user's* private packs. One authorization check function `can(principal, "read", pack)` backed by a materialized `effective_access(pack_id, user_id)` table refreshed on grant changes.
- **Phase 2:** native orgs & teams; grants target teams; seat billing; audit log; token org-restriction.
- **Phase 3:** GitHub App org/team sync (webhooks + nightly reconcile); domain-based access after DNS-verified org domain; disposable-domain blocklist.
- **Phase 4 (enterprise):** SAML/OIDC SSO, SCIM, IP allowlists on tokens, 1-year audit retention.

---

## C) Ratings and community

### C.1 Signals

| Signal | Cost to user | Gaming risk | Information |
|---|---|---|---|
| **Star** (bookmark-like, GitHub/npm style) | 1 click | medium (bot accounts) | popularity/intent |
| **1–5 rating + optional review** | 10s | high (review bombing, self-rating) | sentiment, but small-n averages are noisy |
| **"Works for me / Didn't work"** on a *specific version* with the client (cn x.y, Claude Code z) | 1 click, contextual | medium | *compatibility* — the thing agents actually need |
| **Verified adoption** (a fetch by `cn adopt` or the scheduled update under the principal's token, deduped per principal per 30 days) | 0 | low if authenticated | adoption; the only signal agents generate on their own |
| **Bug report** | minutes | low | quality, maintainer responsiveness |

**Recommendation:** Stars + per-version "works / doesn't work" + verified adoptions. Skip 1–5 star reviews at launch (every registry that has them — VS Code Marketplace, Chrome store — spends disproportionate effort moderating them, and agents can't interpret a 3.8 vs 4.1). Weight signals from accounts with verified adoptions of that pack ("verified-usage weighting": a 'works for me' from someone whose member vendors it counts 1.0, from someone who doesn't 0.25).

### C.2 Bug reports

- If the pack has a **linked public repo**: default to **"Report on GitHub"** — pre-filled issue template URL (`/issues/new?template=pack-bug.yml&title=...&body=...` with pack version, engine version, redacted environment). We store only a lightweight record `(pack_id, version, reporter, github_issue_url, status)` and mirror status via the GitHub App's `issues` webhook. This keeps triage where maintainers already work.
- If **no public repo**: in-site report → publisher's dashboard inbox, email notification, states Open/Acknowledged/Fixed-in-vX/Won't fix. Counts are public ("3 open reports") to inform users.
- Publishers can toggle "accept in-site reports even with a repo" and set a security contact (`SECURITY.md`-style) for private disclosure; security reports are never public.

### C.3 Anti-abuse

- **One account per human (best effort):** verified email + required second factor at sign-up (passkey preferred, TOTP fallback), Turnstile on sign-up/star/report, GitHub OAuth linking adds account-age signal, disposable-email blocklist, limit of N accounts per payment instrument fingerprint (Stripe `payment_method.card.fingerprint`) when credits are purchased.
- **Age gates for actions:** star/'works for me' after 24h account age; bug reports after email verified; publishing after MFA enrolled + (credit OR verified org OR 30-day age). npm/PyPI both made 2FA mandatory for publishers; we do it from day one (owner requirement).
- **Rate limits:** Workers Rate Limiting binding (`simple.limit` per 10s or 60s window, keyed by user id/token/route; eventually-consistent per-colo, so it's a first line, not accounting) plus durable per-day counters in D1/Durable Objects for publishes, reports, token mints. Source: [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
- **Moderation:** star velocity anomaly detection (z-score vs pack's baseline → hold from ranking until reviewed), self-stars from the publisher's org excluded, shadow-weighting rather than deletion, admin queue (section D).

### C.3 Ranking formula

Two surfaces: directory browse (recency matters) and MCP search (relevance + reliability matter; recency matters less).

```
quality  = wilson_lower_bound(works, works+fails, z=1.96)        # 0..1, pessimistic for small n
adoption = log10(1 + verified_adoptions_30d) / log10(1 + P95_adoptions_30d)   # 0..1 normalised
stars_n  = log10(1 + stars) / log10(1 + P95_stars)
health   = 0.5*validation_pass + 0.2*has_public_repo + 0.2*verified_publisher + 0.1*updated_within_90d
freshness= 1 / (1 + age_days_of_latest_version/180)              # browse only

directory_score = 0.35*quality + 0.25*adoption + 0.15*stars_n + 0.15*health + 0.10*freshness
mcp_score       = bm25_text_relevance * (0.4 + 0.6*(0.45*quality + 0.25*adoption + 0.30*health))
                  * category_match(1.0 exact / 0.6 parent / 0.2 none)
                  * engine_compat(1.0 if the caller's engine meets minEngineVersion and works-for-me exists for it, else 0.8)
penalties: open_security_report → 0.0; failed latest validation → 0.1; abuse_hold → 0.2; deprecated → 0.3
```
"Trending" uses a Hacker News-style decay `points / (age_hours + 2)^1.8` over 7-day star+adoption deltas. Source for HN formula: [How Hacker News ranking really works](https://www.righto.com/2013/11/how-hacker-news-ranking-really-works.html). New packs get an "exploration" slot (1 of every 10 results in browse) so the cold-start problem doesn't lock out newcomers.

---

## D) UI scheme

### D.1 Sitemap

```
/                          Home / directory (featured, trending, new, categories)
/packs                     Browse + search (filters: category, features, client, verified, has-repo)
/c/<category>              Category page
/p/<owner>/<pack>          Pack detail (tabs: Overview | Contents | Versions | Validation | Reports)
/p/<owner>/<pack>/v/<ver>  Version pin
/u/<handle> | /o/<org>     Public profiles (packs, verification badge)
/search?q=                 Search results (same component as /packs)
/docs/adopt, /docs/mcp     Adopting a pack & MCP connection docs
/login  /signup  /mfa      Auth (passkey-first), /account/security (factors, sessions, tokens)
/dashboard                 Publisher: my packs, validation queue, reports inbox, analytics
/dashboard/new             New pack wizard (manual upload or GitHub)
/dashboard/github          GitHub App connect, repo+path mappings, auto-publish rules
/dashboard/p/<pack>        Manage pack: access, versions, deprecate, transfer
/dashboard/p/<pack>/access Private pack access (people, teams, tokens, invite links, GitHub teams, domains)
/dashboard/org             Org settings: members, teams, domain verification, audit log
/dashboard/billing         Credits, plan, Stripe portal link, invoices
/admin                     Moderation queue, abuse holds, validation overrides, takedowns
/mcp  /.well-known/oauth-protected-resource/mcp  /oauth/authorize  /oauth/token  /oauth/register
```

### D.2 Key screens (summary)

- **Home/directory:** hero search; "Connect your agent" one-liner (`claude mcp add packserver https://mcp.packserver.dev/mcp`); rows: Trending, New & validated, Categories grid with counts, Verified publishers.
- **Category page:** description, sub-categories, filter rail (contents: rules, skills, declared checks, coded checks, guards, tasks; engine compatibility; verified only; has public repo), sort (Recommended/Most adopted/Newest/Recently updated), card grid.
- **Pack detail:** see wireframe 1.
- **Search:** typeahead with category chips, result cards show the feature-summary icons, validation badge, repo badge, adoption count, works-for-me %.
- **Login/MFA:** passkey-first ("Sign in with a passkey" primary; email code fallback; GitHub OAuth as linked identity, never as sole factor for publishers), MFA enrollment interstitial on first publish.
- **Publisher dashboard:** see wireframe 3.
- **New pack wizard:** see wireframe 4.
- **GitHub connect:** install App → pick repos → add mappings `repo + path → pack name` → choose trigger (tag `v*`, release, push to main) → dry-run validation → enable.
- **Validation results:** per-version checklist: manifest schema, file-size/type limits, secret scan, prompt-injection heuristics, link checks, license present, guards judged on fixtures, coded checks compiled and run; each line pass/warn/fail with log excerpt; "Re-run" and "Request manual review".
- **Org verification:** add domain → show TXT record `_packserver-verify.<domain>` → "Check" → verified badge; plus GitHub org link (install App as org owner) as second proof; require org-level MFA for all admins.
- **Billing:** credits balance, "Buy credits" (opens Stripe Checkout), current plan, seats used/paid, "Manage in Stripe" portal, invoices.
- **Admin/moderation:** queue tabs: Flagged packs, Star anomalies, Reports marked abusive, Verification requests, DMCA/takedown; each row: evidence, actions (hold from ranking, unpublish, ban, dismiss), with audit trail.

### D.3 Wireframes (4 most important)

**1. Pack detail page**
```
+------------------------------------------------------------------------------------+
| PackServer   [Search packs________________]   Browse  Categories  Docs   [Sign in] |
+------------------------------------------------------------------------------------+
| acme / gcp-deploy                                1.61021.1  * 1,204   [ Star ]     |
| Deploy and operate workloads on GCP with Claude Code                               |
| by [Acme Corp ✓ verified org]   Category: Cloud > GCP   License: Apache-2.0        |
|                                                                                    |
| [✔ Validation passed 2h ago]  [rules] [4 skills] [6 checks: 4 declared, 2 coded]   |
| [1 guard] [2 tasks: daily, weekly]   Works for me: 92% (n=310, cn 1.61021.1)       |
|                                                                                    |
| +--------------------------------------+  +--------------------------------------+ |
| | Adopt                                |  |  ◉ Public repo                       | |
| |  cn adopt acme/gcp-deploy            |  |  github.com/acme/packs/gcp           | |
| |  [copy]  or ask your agent to        |  |  commit a1b2c3d · 1.61021.1 ✓        | |
| |  "adopt the acme/gcp-deploy pack"    |  |  ---- or when absent ----            | |
| +--------------------------------------+  |  ⚠  NO PUBLIC REPO                   | |
|                                           |  Source not published by the author  | |
| Overview | Contents | Versions | Validation | Reports (3 open)                     | |
| ---------------------------------------------------------------------------------- |
| README rendered here ...                                                           |
|                                                                                    |
| Before you adopt (pre-install manifest)                                            |
|  Rules: RULES.md (1.8k tokens, read by every session)                              |
|  Skills (4): gcp-iam, gke-debug, cloud-run-deploy, bq-cost-review                  |
|  Checks (6): 4 declared, 2 coded (Go)                          [view source]       |
|  Guards (1): denies `gcloud projects delete`                                       |
|  Tasks (2): nightly-cost-report (daily, opens a PR), quota-review (weekly)         |
|                                                                                    |
| [👍 Works for me] [👎 Didn't work]   [Report a bug ↗ GitHub]   [Share]               |
+------------------------------------------------------------------------------------+
```

**2. Home / directory**
```
+------------------------------------------------------------------------------------+
| PackServer                                  Browse  Categories  Publish  [Sign in] |
|                                                                                    |
|            Claudinite packs: checks, rules, skills and tasks                       |
|            [ Search 4,812 packs...                                 🔍 ]             |
|         Connect your agent:  claude mcp add packserver https://mcp.packserver.dev  |
|                                                                                    |
| Trending this week                                            [see all]            |
| +----------------+ +----------------+ +----------------+ +----------------+        |
| | acme/gcp-deploy| | jane/rust-tdd  | | k8s/helm-ops   | | sec/secret-scan|        |
| | ✓ ✓repo chk6 g1| | ✓ ✓repo chk3 g1| | ✓ ⚠norepo sk6  | | ✓ ✓repo chk5   |        |
| | ★1.2k  92%👍   | | ★640   88%👍   | | ★410   79%👍   | | ★380   95%👍   |            |
| +----------------+ +----------------+ +----------------+ +----------------+        |
| chk = checks, g = guards, sk = skills                                              |
|                                                                                    |
| Categories                                                                         |
| [Cloud 312] [Languages 540] [Testing 221] [Security 143] [Data 198] [DevOps 377]   |
| [Docs 96] [Frontend 288] [Mobile 71] [Productivity 150] [Code review 204] ...      |
|                                                                                    |
| New & validated          Verified publishers                                       |
| • foo/bar 1.61022.1 (2h) [Google ✓] [Cloudflare ✓] [Acme ✓] [Stripe ✓]             |
| • ...                                                                              |
+------------------------------------------------------------------------------------+
```

**3. Publisher dashboard**
```
+------------------------------------------------------------------------------------+
| Dashboard  Packs  GitHub  Org  Billing  Tokens               acme ▾  [+ New pack]  |
+------------------------------------------------------------------------------------+
| Credits: 7   Plan: Team (12/15 seats)   [Buy credits] [Manage billing]             |
|                                                                                    |
| Needs attention (2)                                                                |
|  ✖ acme/bq-tools 1.61020.1  validation FAILED: secret detected in skills/x  [view] |
|  ● acme/gcp-deploy       3 open bug reports, oldest 6d                     [inbox] |
|                                                                                    |
| Your packs                Visibility  Stable      Validation      30d adopt.   👍   |
|  acme/gcp-deploy          public      1.61021.1   ✔ passed            4,120   92%  |
|  acme/bq-tools            public      1.60911.2   ✖ 1.61020.1 fail      980   85%  |
|  acme/internal-runbooks   private 🔒  1.60830.1   ✔ passed              210   n/a   |
|     access: team platform-eng (GitHub) · 3 tokens · 2 invites pending   [manage]   |
|                                                                                    |
| GitHub auto-publish                                                                |
|  acme/packs  path packs/gcp  → acme/gcp-deploy   on tag v*   last run ✔ 2h         |
|  acme/packs  path packs/bq   → acme/bq-tools     on tag v*   last run ✖ 1d         |
|  [+ Add mapping]                                                                   |
+------------------------------------------------------------------------------------+
```

**4. New pack wizard (step 3 of 5: validation)**
```
+------------------------------------------------------------------------------------+
| New pack   (1) Source ✔  (2) Metadata ✔  (3) Validation ●  (4) Visibility  (5) Pay |
+------------------------------------------------------------------------------------+
| Validating acme/gcp-deploy @ 1.61021.1 (uploaded 1.2 MB, 23 files)                 |
|                                                                                    |
|  ✔ pack.json schema valid                  ✔ License file present (Apache-2.0)     |
|  ✔ File types & size within limits         ✔ Links resolve (14/14)                 |
|  ✔ No secrets detected                     ⚠ 1 skill > 8k tokens (perf warning)    |
|  ✔ Prompt-injection heuristics: none       ✔ Guards judged on fixtures (1/1)       |
|  ✔ Coded checks compiled and run (2/2)     ● Contents extracted:                   |
|                                               RULES.md · 4 skills · 6 checks ·     |
|                                               1 guard · 2 tasks                    |
|                                                                                    |
|  Detected category: Cloud > GCP  [change]                                          |
|                                                                                    |
|  Logs ▸  Re-run ▸                                                                  |
|                                                                                    |
|                                           [◀ Back]   [Continue to visibility ▶]    |
+------------------------------------------------------------------------------------+
```

### D.4 Step-by-step flows

**Sign up + enroll passkey**
1. `/signup`: email → 6-digit code (Turnstile on submit). 2. Choose handle. 3. "Protect your account" — Create passkey (WebAuthn `create()`, RP id `packserver.dev`, resident key preferred, user verification required); fallback "Use an authenticator app" (TOTP). 4. Show 8 recovery codes, require acknowledgement. 5. Optional: link GitHub (OAuth) for publisher trust signals. 6. Land on `/packs` with "Connect your agent" toast. Publishing is blocked until step 3 is done.

**Publish manually**
1. Dashboard → New pack → Source: "Upload archive" (tar.gz ≤ 3 MB, the format cn reads today; O3 open) or "Point at a repo" (next flow). 2. Metadata: name (scoped under handle/org), summary, category (suggested from contents), license, public repo URL (optional; if given, we fetch and compare a file hash to show "matches repo at tag" badge). 3. Validation runs (Worker → Queue → validator; status streamed). 4. Visibility: Public (1 credit) or Private (needs plan). 5. Pay: if no credit → Stripe Checkout ($1 single or bundle) → webhook `checkout.session.completed` grants credit → returns to wizard → "Publish" consumes credit and copies the object from staging R2 prefix to `packs/<id>/<version>.tar.gz` with immutable metadata and rewrites the signed `packs/<id>/index.json` and `packs/catalog.json`; D1 version row created; search index updated; MCP cache purged.

**Set up GitHub auto-publish**
1. Dashboard → GitHub → "Install PackServer app" (GitHub App; permissions: Contents read, Metadata read; optional Members read for access sync). 2. Select repos. 3. Add mapping: repo, path (`packs/gcp`), target pack (existing or new), trigger (tag matching `v*` | release published | push to branch). 4. "Dry run": we fetch the tree at HEAD via installation token, run validation, show results. 5. Enable. On webhook `push`/`release` (signature verified with `X-Hub-Signature-256`), we fetch tarball → validate → publish version (no credit needed for versions; new pack creation via GitHub still needs a credit or waiver). 6. Provenance: record repo, commit SHA, tag, workflow run id; display "Built from github.com/acme/packs@a1b2c3d". 7. Failure → email + dashboard "Needs attention".

**Report a bug**
1. Pack page → "Report a bug". 2. If signed-out → login. 3. If pack has repo: modal "This will open a pre-filled issue on GitHub" → new tab with template; on return we ask to paste/auto-detect issue URL (optional) so it shows under Reports. 4. If no repo: form (version, engine version, what happened, steps, "contains sensitive info → send privately to publisher"). 5. Publisher notified; status lifecycle shown publicly except private reports.

**Star / rate**
1. Click Star (login required; account ≥24h for the count to be public — otherwise stored as pending). 2. "Works for me / Didn't work" prompts for the engine version (prefilled from the last recorded adoption if any); one vote per user per pack-version, changeable. 3. Votes from principals with a verified adoption carry full weight. 4. Agents can submit "works for me" via MCP tool `report_pack_outcome` only on behalf of an authenticated user and only after an adoption was recorded.

**Grant access to a private pack**
1. Dashboard → pack → Access. 2. Tabs: People (add by handle/email → invite email), Teams (org teams), GitHub teams (if App installed on org: pick `org/team` → sync), Domains (org must have verified domain; toggle "anyone with verified @acme.com"), Tokens (name, scope `packs:read`, restrict to this pack/org, expiry default 90d; show once), Invite links (expiry, max uses, optional domain restriction). 3. Every change writes an audit row and rebuilds `effective_access` for the pack. 4. Readers see the pack under "Shared with me" and via MCP after re-auth or token use.

**Agent finds a pack via MCP and the member adopts it**
1. User: `claude mcp add packserver https://mcp.packserver.dev/mcp` (Streamable HTTP). 2. Agent calls `search_packs({query:"deploy to GCP", category:"cloud/gcp"})` anonymously → ranked public results with content summaries, validation status, works-for-me %, `minEngineVersion` and channel. 3. `get_pack({id, version?})` returns the manifest, the pre-install manifest (guards, tasks and cadence, forced skills, GitHub actions) and the `cn adopt` / `packs.declared` snippet. 4. The agent runs `cn adopt <id>` (or adds the pack to `packs.declared` in the member's Claudinite settings); `cn` fetches the archive, verifies it against the signed index and vendors it into the repo, and an adoption is recorded from that fetch. The agent never downloads the archive itself. 5. If the user asks for a private pack: server returns `401` + `WWW-Authenticate: Bearer resource_metadata=..., scope="packs:read"`; client discovers AS metadata, registers via CIMD or DCR, runs PKCE auth-code flow in the browser (passkey login + consent page listing scopes and orgs), receives an audience-bound token, retries. 6. Later `report_pack_outcome({pack, version, outcome:"works"})` feeds the ranking.

---

## Source index
- Stripe: [fees 2026](https://flexprice.io/blog/stripe-pricing-breakdown-2026) · [minimum charge amounts](https://docs.stripe.com/currencies.md) · [Checkout vs PaymentIntents](https://edge-docs.stripe.com/payments/checkout-sessions-and-payment-intents-comparison) · [Stripe Tax PAYG](https://support.stripe.com/questions/understanding-stripe-tax-pay-as-you-go-pricing) · [webhook signatures](https://docs.stripe.com/webhooks/signature.md) · [Hono/Workers constructEventAsync example](https://hono.dev/examples/stripe-webhook)
- MoR alternatives: [Paddle vs Lemon Squeezy 5%+50c](https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/)
- Registry pricing: [npm](https://npmjs.com/pricing) · [GitHub Packages](https://docs.github.com/en/billing/concepts/product-billing/github-packages) · [Docker](https://www.docker.com/pricing/) · [JFrog](https://jfrog.com/pricing/)
- Publisher security precedent: [PyPI 2FA for all](https://blog.pypi.org/posts/2024-01-01-2fa-enforced/) · [npm trusted publishing OIDC](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/) · [GitHub publisher verification (domain + 2FA)](https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/applying-for-publisher-verification-for-your-organization)
- MCP auth: [spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) · [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider/)
- GitHub App: [permissions & events](https://docs.github.com/en/enterprise-server@3.9/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- Cloudflare: [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- Ranking: [Hacker News formula](https://www.righto.com/2013/11/how-hacker-news-ranking-really-works.html)
