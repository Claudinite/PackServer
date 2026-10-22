# The World DSL

Status: design, 2026-10-22. Layer 2 of the plan in [README.md](README.md). Package name `@packserver/world`, source under `tests/world/**`. This document is the contract scenario authors write against; the implementation may change freely as long as scenarios keep reading the same.

## 1. Design rules

1. **One sentence per line.** Every line of a scenario is one domain action or one observation: `const u = await world.users.create(); await u.signIn();`. Plain `await` per line, no builder chains for commands, no `try`/`catch`, no `Promise.all` unless the scenario is about concurrency.
2. **Nouns are handles, verbs are methods on the noun.** `world.users.create()` returns a `User`; `user.scopes.create('acme')` returns a `Scope`; `scope.packs.publish(...)` returns a `Version`; `version.yank(...)` is a method on the version. A scenario rarely needs to pass an ID around.
3. **Commands return, observations assert.** A verb never asserts on a business outcome; it returns a handle or a result. Only `expect(...)` lines assert. Expected refusals are matchers on a promise (`await expect(token.mint()).toBeRefused('step-up')`). A verb throws only for infrastructure failures (the harness is down), with a distinct `InfrastructureError` the reporter shows differently.
4. **Defaults are the common case.** `world.users.create()` is a member with a verified email and no MFA. `world.publishers.create()` is a member with a passkey enrolled, signed in, owning a personal scope, with zero credits. A scenario names only the option it is about.
5. **The World owns everything stateful.** Fakes, the clock, the recorder, aliases and the driver live on `world`; a scenario never imports anything but `scenario`, `expect` and types from `@packserver/world`.
6. **Names are invented and aliased.** `'acme'` in a scenario becomes `acme-7f3a` in the system; handles and matchers translate back, so output reads as the scenario wrote it. Real product or company names appear only when the scenario is about that name (reserved-word refusals).
7. **Time is moved, never waited for.** `await world.clock.advance('24h1m')`. The DSL exposes no sleep.
8. **Step-up is part of the verb.** A sensitive action needs a passkey assertion bound to that action and its target (REQ-ACC-010), so every sensitive verb (`tokens.mint`, `version.approve`, `version.yank`, `org.setRole`, `pack.setVisibility`, …) makes that assertion with the actor's enrolled passkey by itself. There is no `stepUp()` to call first and no window to keep fresh. The negatives are options on the verb: `{ assertion: 'none' }` (no assertion), `{ assertion: await other.assertionFor(...) }` (the wrong session, action or target), `{ assertion: 'replay' }` (the previous one again).

## 2. Vocabulary

### 2.1 Actors

| Actor | Created by | Default state |
|---|---|---|
| `Visitor` | `world.visitor()` | anonymous browser, no session; `.asCrawler()` variant |
| `User` (member) | `await world.users.create(opts?)` | verified email, no MFA, not signed in; `opts`: `{ email?, ageDays?, via?: 'github' \| 'passkey' \| 'email', mfa?: 'passkey' \| 'totp', handle? }` |
| `Publisher` | `await world.publishers.create(opts?)` | member + passkey + signed in + personal scope; sensitive verbs assert with the passkey by themselves (rule 8); `opts`: `{ credits?, verified?: boolean }` |
| `Operator` | `world.operator` | the release flow's or the prober's identity: holds the probe credential in-process and under `http`; the only actor that can see a self-test |
| `Org` | `await publisher.orgs.create('acme')` | org scope owned by `publisher` |
| `OrgMember` | `await org.invite(user).as('maintainer')` | role `owner` \| `maintainer` (the UI's two roles; the architecture's four map onto them in the driver) |
| `Agent` | `world.agents.anonymous()`, `await world.agents.withToken(token)`, `await world.agents.oauth(user)` | an MCP client; `anonymous` needs no await |
| `CiWorkflow` | `world.github.workflow({ repo, workflowFile, environment?, ref?, forkOf? })` | a GitHub Actions run that can request OIDC tokens and run the publish action |
| `CnRepo` | `world.cn.repo()` | a cn engine instance: fetches indexes, verifies signatures, downloads, reports installs |
| `Admin` | `await world.admins.create()` | a person with an Access identity on the admin host; `world.visitor().withForgedAccessHeader()` is the negative |
| `Clock` | `world.clock` | `advance(duration)`, `set(iso)`, `now()` |
| probe publisher | `await world.probe.publisher()` | the publisher of the synthetic scope (`@probe`); the only actor a `probe-safe` scenario may write as. In-process it is a synthetic scope like any other; under `http` it is the probe token |

Acting as someone specific: `user.as(session)` returns the same `User` bound to one of its sessions (`user.as(phone).inbox()`); `pack.as(user)` returns the pack as seen and acted on by that user (`pack.as(mallory).version('1.0.0').yank(...)` for cross-scope negatives). Handle verbs without `as` act as the handle's owner's current session.

Personas (object mothers) for states requirements name: `world.personas.verifiedPublisher('acme')` (org with domain + GitHub proof + MFA enforcement + Verified Publisher), `world.personas.youngUser()` (account 1 h old), `world.personas.suspendedPublisher()`.

### 2.2 Entities (handles)

`Scope`, `Org`, `Pack`, `Version`, `Archive` (a fixture: `world.archive('gcp')`, `world.archive('with-secret')`, `world.archive('gcp', { version: '2.0.0', files: {...} })`), `Manifest`, `Inventory`, `Attestation`, `ScopeIndex`, `RootIndex`, `ValidationRun`, `Report`, `Finding`, `TrustedPublisher`, `Token`, `Assertion` (a per-action passkey assertion, for negatives), `CreditBalance`, `Subscription`, `Grant`, `Invite`, `AccessRequest`, `Review`, `BugReport`, `SecurityReport`, `AbuseReport`, `Advisory`, `AuditEntry`, `AuditBatch`, `AuditHead`, `Badge`, `DomainChallenge`, `SelfTest`, `Email`, `Notification`. There is no `CheckRun` and no mirror handle: PackServer writes nothing to GitHub, and `world.github.writes()` exists only to prove that.

Every handle knows its World and its driver; `pack.name` is the scenario's name (`@acme/gcp`), `pack.systemName` the aliased one. Handles are cheap views: `pack.version('1.1.0')` does not hit the system until a verb or observation does. `world.packs.get('@acme/gcp')` returns the handle for a pack created earlier in the scenario; `pack.owner()` returns its owning publisher.

Archive fixtures: `'gcp'`, `'with-secret'`, `'with-symlink'`, `'with-hardlink'`, `'case-collision'`, `'absolute-size-bomb'`, `'nested-archive'`, `'with-html'` (each named after the property a validation requirement rejects or renders).

### 2.3 Verbs (commands), grouped by actor

```ts
// User
await user.signIn({ via?: 'github' | 'passkey' | 'email' })              // default: the method the user was created with; there is no Google
await user.signOut()
await user.chooseHandle('ariel')
await user.mfa.enrollPasskey();  await user.mfa.enrollTotp();  await user.mfa.remove(factor)
await user.mfa.recoveryCodes()                                           // -> string[10], shown once
await user.assertionFor(action)                                          // -> Assertion bound to this session and that action (for negatives on another verb)
await user.failAssertion({ times: 5 })                                   // n failed per-action assertions (REQ-ACC-011)
await user.sessions.list();  await user.sessions.revoke(session)
await user.star(pack);  await user.unstar(pack)
await user.review(pack, { rating: 4, body?: '...' })
await user.vote(pack, '1.0.0', 'works', { client: 'claude-code' })
await user.report(pack).bug({ version, severity, repro, attachments? })
await user.report(pack).security({ ... })
await user.reportAbuse(pack | review | profile, { category, details })
await user.requestAccess(pack, { answers, acceptTerms: true })
await user.tokens.mint({ read: pack })                                   // read token; the per-action assertion is made inside the verb
await user.tokens.list()                                                 // -> Token[] with lastUsed (hourly-accurate, REQ-AUDIT-006)
await user.account.delete();  await user.account.changeEmail(addr)
await user.recover()                                                     // no-factor recovery
await user.providers.link('github')                                      // GitHub or a passkey; nothing else exists
await user.signIn({ next: 'https://evil.example' })                     // -> Session; .landedOn is where the site sent them
await user.tokens.mint({ read: pack, assertion: 'none' })               // sensitive verb without its assertion (negative)
await user.tokens.mint({ read: pack, assertion: await user.as(otherSession).assertionFor('token.mint') })  // wrong session
await user.tokens.mint({ read: pack, assertion: await user.assertionFor({ yank: version }) })             // wrong action/target
await user.tokens.mint({ read: pack, assertion: 'replay' })             // the previous assertion again

// Publisher (a User with more)
await publisher.orgs.create('acme')
await publisher.credits.buy(5)                                           // drives fake Stripe Checkout + webhook
await publisher.credits.beginPurchase(5)                                 // -> Checkout handle; the webhook is delivered by the scenario
await publisher.publish(archive).as('@acme/gcp@1.0.0', { visibility?: 'private', staged?: true })  // web upload path
await publisher.packs.reserve('@acme/gcp')                               // pending name
await publisher.trustedPublishers.add(pack, { repo, workflowFile, environment?, path })
await publisher.tokens.mint({ scopes: ['publish:update'], pack?, scope?, ttl?: '7d', cidr? })
await version.approve()                                                  // staged publish approval (passkey)
await version.deprecate(reason);  await version.yank({ reason, security?: true });  await version.unyank()
await version.delete()
await pack.setVisibility('private' | 'public')
await pack.transfer(org)
await pack.access.grant(user);  await pack.access.invite(email);  await pack.access.inviteLink({ expires: '7d' })
await pack.access.revoke(user);  await pack.access.gate({ fields, terms, autoApprove? })
await pack.access.approve(request);  await pack.access.deny(request)
await review.reply('...');  await review.flag()
await report.setStatus('fixed', { in: '1.0.1' })

// Org
await org.invite(user).as('maintainer');  await org.remove(user);  await org.setRole(user, 'owner')
await org.verifyDomain('acme.com')                                       // -> DomainChallenge
await org.checkDomain()                                                  // -> 'verified' | 'not_found' | 'mismatch'
await org.verifyGitHub('acme')                                           // installs the fake App as the current user
await org.security.requireMfa({ passkeysOnly?: true })
await org.billing.subscribe('team', { seats: 3 })
await org.delete()

// Agent (MCP)
await agent.search('deploy to GCP', { category?, includeFresh?, client?, verifiedOnly? })
await agent.categories()
await agent.get(pack, version?)
await agent.download(pack, version)
await agent.myPacks()
await agent.reportOutcome(pack, version, 'works' | 'fails', { client })
await agent.star(pack)
await agent.tools()                                                      // names visible to this caller
await agent.callUnlistedTool(name)                                       // a tool this caller was not shown (negative)
await agent.authenticate({ redirectTo?, state?: false })                 // OAuth through the fake login; options for negatives

// CI workflow / cn
await workflow.run({ tag: 'v1.0.0' })                                    // -> { version?, refusal? }; the verdict is read from the dashboard and mail, never from GitHub
await workflow.publishes(pack, '1.2.3')                                  // -> Version (or a refusal, for matchers)
workflow.oidcToken({ aud?, iss?, exp?, nbf?, alg?, kid?, ...claims })    // minted with overrides, for negative tests
await workflow.upload(archive, { reuse?: upload })                       // the 15-minute upload credential; reuse replays it
world.github.webhook(event, { signature?: 'wrong' | 'missing', installation? })  // a delivery the World can send
await cn.fetchIndex('acme');  await cn.fetchRoot();  await cn.download(pack, version);  await cn.reportInstall(pack, version)

// Admin
await admin.queue.list();  await admin.queue.approve(version);  await admin.queue.reject(version, reason)
await admin.quarantine(pack);  await admin.suspend(publisher);  await admin.revokeVerification(org)
await admin.grantVerifiedPublisher(org);  await admin.resolveDispute(handle).to(org)
await admin.recovery.approve(user)

// World-level
await world.validation.completes(version)                                // runs the workflow to a verdict, gates auto-answered
await world.validation.of(version)                                       // -> ValidationRun handle (verdict(), report(), findings())
await world.cron.run('domain-rechecks' | 'stats-rollup' | 'staging-expiry' | 'rescan' | 'audit-head' | 'audit-verify' | 'activity-prune')
await world.clock.advance('31d')
world.dns.publishTxt(name, value);  world.dns.remove(name)
world.github.repo('acme/tool');  world.github.installApp({ org, installer })
world.github.rotateJwks()                                                // the issuer publishes a new key and drops the old one
world.stripe.event('checkout.session.completed', { session })           // an event the World can deliver, incl. replay
await world.stripe.deliver(event, { signature?: 'wrong' })               // sends it to the webhook endpoint
world.llm.script({ verdict: 'flag', risk: 0.8 })
world.sandbox.script(archive, { exitCode, egressAttempts })
world.registryKey();  world.registryKey('previous')                      // the index-signing public key(s) cn trusts
world.tokens.leakReport(tokenOrPrefix)                                   // the public leak-report form
world.audit.tamper(batch, { drop: true } | { alter: true })              // corrupt a stored audit batch (negative for REQ-AUDIT-005)
world.operator.stall('outbound.github' | 'r2.packs-public' | …)          // make the dependency behind one self-test check hang
await world.database.setMigrationHead(n)                                 // move the registry's applied migration head (REQ-OPS-011)
```

### 2.4 Observations

```ts
await visitor.open(pack)                   // -> PackPage | NotFound   (.status, .badges, .warnings, .latest, .installs)
await visitor.browse({ q, category, sort })
await visitor.profile(org)                 // -> ProfilePage (.badges, .packs)
await user.inbox()                         // in-site notifications
await world.mail.inbox(user).latest()      // -> Email (.subject, .links, .code)
await world.audit.for(user | org)          // -> AuditEntry[] (the 90-day copy the pages show)
await world.audit.batches()                // -> AuditBatch[] as stored in the write-once bucket, each with .previousHash
await world.audit.heads()                  // -> AuditHead[] served at the well-known path
await world.rekor.entries()                // -> what the registry published to the transparency log fake
await world.audit.verify()                 // -> 'intact' | { mismatch: AuditBatch } and the page it raised
await world.github.writes()                // -> [] always: every write the fake GitHub was asked for (REQ-PUB-033, REQ-MOD-001)
await world.operator.selfTest({ shallow?: true })   // -> SelfTest (.ok, .versionId, .releaseId, .checks[], .check(name))
await world.visitor().selfTest()           // -> NotFound (REQ-OPS-004)
world.operator.deployedVersion()           // the version id under test (the harness's, or the http override)
world.operator.observedVersions()          // every version id seen on a response in this scenario (REQ-OPS-006)
await world.storage.fingerprint()          // a digest of D1, R2, KV and queue state, canary objects excluded (REQ-OPS-008)
await world.staging.objects()
await world.recorder.invocations({ kind?, target?, effect? })   // kind: one or a list of the release plan's kinds, plus 'service' for a service-binding call
await world.telemetry.recorded()           // signals, see §7
await pack.versions();  await pack.latest();  await pack.index()
await version.status();  await version.sha256();  await version.attestation()
await publisher.credits.balance()
await publisher.dashboard()                // .alerts, .drafts, .packs
await agent.tools()
results.first();  results.card(pack)       // on a search result: the top card, the card for a pack
await session.cookie()                     // -> { host-only, secure, httpOnly, sameSite } as the driver observed them
await download.headers()                   // -> { caching: 'private' | 'immutable' | 'public', disposition, sniffable }
await visitor.page(pack).headers()         // the site's response headers as the World names them
```

## 3. Custom matchers

Matchers hide protocol detail. Each works on a value or on a promise (Vitest's async matchers), so refusals are asserted without `try`/`catch`.

| Matcher | Passes when | Hides |
|---|---|---|
| `toBeNotFound()` | the observation is the same shape as for a nonexistent resource | 404 vs 403, page vs JSON vs MCP error |
| `toBeRefused(reason?)` | the command was refused, optionally with reason code `'step-up'` (no valid per-action assertion: missing, for another action or target, from another session, or replayed) `\| 'mfa-required' \| 'oidc.fork' \| 'oidc.workflow' \| 'oidc.environment' \| 'oidc.invalid' \| 'signature' \| 'signed-out' \| 'rate-limited' \| 'human-check' \| 'forbidden' \| 'exists' \| 'trusted-only' \| 'quota' \| 'unknown-tool' \| 'scope'` | status codes, error envelopes, MCP `isError` |
| `toBeIgnored()` | a delivery (webhook, replayed event) was acknowledged and nothing happened | the acknowledgement shape |
| `toBePack(pack)` | a result card is that pack | card shape |
| `toVerifyAgainst(key)` / `toHaveValidSignature()` | an attestation or index verifies with the registry key | signature format |
| `toLookTheSameAs(other)` | two observations are identical in shape, body and the headers the World exposes (timing is out of scope in-process) | which headers |
| `toBeRefusedWithClaimDiff({ repository })` | an OIDC refusal names the mismatched claims | the diff format |
| `toBeHeld(reason?)` | a download is held for quarantine | 451 and body |
| `toBeLive()` | a version is promoted, downloadable, in the index | three endpoints |
| `toHaveProvenance({ repo, ref, commit? })` | the version's provenance matches | where provenance is stored |
| `toContainPack(pack)` / `toContainVersion(pack, v)` | a search result or index lists it | card shape |
| `toContainEmail({ about })` | an inbox has a mail whose subject or body matches | provider format |
| `toContainAction(action)` | an audit list has an entry with that action | table |
| `toHaveRecorded(signal, attrs?)` | the telemetry sink saw the signal | sink format |
| `toHaveBeenAskedBefore(event)` / `not.toHaveBeenAsked()` | the recorder shows a call to the fake before/after a World event | recorder format |
| `toHaveAttemptedNoEgress()` | the sandbox fake recorded no network attempt | recorder |
| `toBeRateLimited()` | the response is the rate-limit shape | 429 |
| `toRequireHumanCheck()` | the form refused for a failed Turnstile | — |

Banned in scenarios (lint): `toBeTruthy`, `toBeDefined`, `expect.anything()`, bare `toBe(200)`-style numbers, and `expect.any()` as a whole assertion. `expect.any(Number)` is allowed only as a field inside `toMatchObject` / `objectContaining`, where it asserts shape ("there is a numeric context cost") rather than nothing.

Illustrative: §2 and §3 list the vocabulary the examples and the register need today; the World grows verbs freely, and the lint, not this list, is what decides whether a scenario is in the domain language.

## 4. Handles and the interfaces

```ts
// tests/world/world.ts
export interface World {
  readonly driver: DriverKind;
  users: { create(opts?: UserOpts): Promise<User> };
  publishers: { create(opts?: PublisherOpts): Promise<Publisher> };
  personas: Personas;
  visitor(): Visitor;
  agents: { anonymous(): Agent; withToken(t: Token): Promise<Agent>; oauth(u: User): Promise<Agent> };
  admins: { create(): Promise<Admin>; notifications(): Promise<Notification[]> };
  cn: { repo(): CnRepo };
  packs: { public(name: string, opts?: { versions?: string[] }): Promise<Pack>; private(name: string): Promise<Pack>; nonexistent(name: string): Pack; get(name: string): Pack };
  probe: { publisher(): Promise<Publisher> };
  tokens: { leakReport(tokenOrPrefix: string): Promise<void> };
  registryKey(which?: 'current' | 'previous'): PublicKey;
  archive(fixture: string, opts?: ArchiveOpts): Archive;
  validation: { completes(v: Version): Promise<ValidationRun>; of(v: Version): Promise<ValidationRun> };
  cron: { run(job: CronJob): Promise<void> };
  clock: Clock;
  github: FakeGitHub;   stripe: FakeStripe;   llm: FakeLlm;   sandbox: FakeSandbox;
  mail: FakeMail;       dns: FakeDns;         turnstile: FakeTurnstile;   rekor: FakeRekor;
  audit: { for(subject: User | Org): Promise<AuditEntry[]>; batches(): Promise<AuditBatch[]>; heads(): Promise<AuditHead[]>;
           verify(): Promise<AuditVerdict>; tamper(b: AuditBatch, how: { drop: true } | { alter: true }): void };
  operator: Operator;
  storage: { fingerprint(): Promise<string> };
  database: { setMigrationHead(n: number): Promise<void> };
  staging: { objects(): Promise<string[]> };
  recorder: RecorderView;
  telemetry: TelemetrySink;
  alias(name: string): string;
  dispose(): Promise<void>;
}

export interface User {
  readonly handle: string;
  as(session: Session): User;
  signIn(opts?: SignInOpts): Promise<Session>;
  signOut(): Promise<void>;
  assertionFor(action: SensitiveAction): Promise<Assertion>;       // for handing to another verb's `assertion` option
  failAssertion(o: { times: number }): Promise<void>;
  mfa: Mfa;  sessions: Sessions;  tokens: UserTokens;  account: Account;  providers: Providers;
  star(p: Pack): Promise<void>;  unstar(p: Pack): Promise<void>;
  review(p: Pack, r: ReviewOpts): Promise<Review>;
  vote(p: Pack, version: string, result: 'works' | 'fails', o: { client: string }): Promise<void>;
  report(p: Pack): ReportBuilder;
  reportAbuse(target: Pack | Review | Org, o: AbuseOpts): Promise<AbuseReport>;
  requestAccess(p: Pack, o: AccessRequestOpts): Promise<AccessRequest>;
  open(p: Pack): Promise<PackPage | NotFound>;
  inbox(): Promise<Notification[]>;
}

export interface Publisher extends User {
  scope: Scope;                                   // personal scope
  orgs: { create(name: string): Promise<Org> };
  credits: { buy(n: number): Promise<void>; beginPurchase(n: number): Promise<Checkout>; balance(): Promise<number> };
  publish(a: Archive): { as(nameAtVersion: string, o?: PublishOpts): Promise<Version> };
  packs: { reserve(name: string): Promise<Pack> };
  trustedPublishers: { add(p: Pack, tp: TrustedPublisherSpec): Promise<TrustedPublisher> };
  tokens: PublisherTokens;
  dashboard(): Promise<Dashboard>;
}

export interface Version {
  readonly pack: Pack;  readonly version: string;
  status(): Promise<VersionStatus>;  sha256(): Promise<string>;  attestation(): Promise<Attestation>;
  approve(o?: Sensitive): Promise<void>;  deprecate(reason: string, o?: Sensitive): Promise<void>;
  yank(o: { reason: string; security?: boolean } & Sensitive): Promise<void>;  unyank(o?: Sensitive): Promise<void>;
  delete(o?: Sensitive): Promise<void>;
}

// every sensitive verb accepts this; the default makes the action-bound assertion with the actor's passkey
export interface Sensitive { assertion?: 'none' | 'replay' | Assertion }

export interface Operator {
  selfTest(o?: { shallow?: boolean; worker?: WorkerName }): Promise<SelfTest>;   // refused as rate-limited after the budget (REQ-OPS-009)
  deployedVersion(): string;
  observedVersions(): ReadonlySet<string>;
  stall(check: string): void;                                                     // in-process only
}
export interface SelfTest {
  readonly ok: boolean;  readonly versionId: string;  readonly releaseId: string;
  readonly checks: ReadonlyArray<{ name: string; ok: boolean; ms: number; detail?: string | object }>;
  check(name: string): { name: string; ok: boolean; ms: number; detail?: string | object } | undefined;
}
```

Every method on a handle resolves through `world.driver`. Under `inprocess` and `http` the call is an HTTP request the driver builds; under `browser` the verbs marked as UI actions in the driver (`signIn`, `mfa.enrollPasskey`, the per-action passkey ceremony inside a sensitive verb, `publish(...).as` via the wizard, `version.approve`) go through the page and everything else still goes through HTTP; under `mcp` the `Agent` verbs are tool calls. `world.operator` sends the probe credential (the Access service token and the HMAC header under `http`; the harness's equivalent in-process) only with `selfTest`, never on other verbs.

```ts
// tests/drivers/driver.ts
export interface Driver {
  readonly kind: 'inprocess' | 'http' | 'browser' | 'mcp';
  readonly capabilities: ReadonlySet<Capability>;
  http: { request(req: ApiRequest): Promise<ApiResponse> };
  ui?: UiActions;
  mcp?: { client(creds?: Credentials): Promise<McpClient> };
  fakes?: Fakes;  clock?: Clock;  telemetry?: TelemetrySink;  recorder?: RecorderView;
  reset(): Promise<void>;  dispose(): Promise<void>;
}
```

## 5. The `scenario()` helper, requirement naming and tags

```ts
// tests/world/scenario.ts
export function scenario(title: string, fn: (world: World) => Promise<void>, opts: ScenarioOpts = {}) {
  const ids = [...title.matchAll(/\bREQ-[A-Z]+-\d{3}\b/g)].map(m => m[0]);
  if (ids.length === 0) throw new Error(`scenario "${title}" names no requirement`);
  const tags = [...ids.map(id => `req/${id}`), ...(opts.tags ?? [])];
  test(title, { tags }, async ({ annotate, skip }) => {
    for (const id of ids) await annotate(id, 'requirement');
    const driver = currentDriver();
    const missing = [...needs(opts.tags), ...(opts.needs ?? [])].filter(c => !driver.capabilities.has(c));
    if (missing.length) skip(`driver ${driver.kind} lacks ${missing.join(', ')}`);
    const world = await World.create(driver, { reset: opts.needs?.includes('reset') });
    try { await fn(world); } finally { await world.dispose(); }
  });
}
```

- The requirement ID is in the title, first, so humans, `git log -S`, the register check and the reporters all see the same string. A scenario may name several IDs when one observation genuinely proves several (yank: REQ-MOD-011 with REQ-DELIV-005 and REQ-DELIV-008).
- `opts.needs`: capabilities beyond what the tags imply; `'reset'` asks for an empty world (storage reset before this scenario, ~1.5 s) instead of the default alias isolation.
- **Tags, the one list** (README and stability-checks refer here): `probe-safe` (runs against a deployment; must need no fake, clock, sink, recorder or storage seam, and writes only as `world.probe.publisher()` or reads as `world.operator`; lint-checked), `ui` (needs the browser driver), `agent` (needs the MCP client), `compat` (crosses a service-binding edge; re-run by the release plan's N/N-1 stage), `slow` (over 5 s in-process; nightly lane only), `quarantined` (flaky; runs nightly, reported, not gating; README §10), `provisional` (added by the helper from the register's status, never by the author). All are declared in the Vitest config; an undeclared tag fails collection.
- Vitest's tags are strict by default: the requirement tags are generated from the register at config load, so an unknown or retired ID fails collection ([Vitest test tags](https://vitest.dev/guide/test-tags)); the spike shows the error.

## 6. World lifecycle and isolation

| Moment | What happens |
|---|---|
| once per file | the driver boots: `setGlobalDispatcher(new Agent())`, MSW `listen({ onUnhandledFrame: 'error' })`, `createTestHarness().listen()`, `server.reset()` and D1 migrations (2.2–2.5 s boot plus 1.1–1.8 s reset, measured in the spike) |
| per scenario | `World.create(driver)`: fake state cleared, MSW handlers reset, Recorder cleared, clock set to the fixed epoch `2026-01-15T10:00:00Z`, RNG reseeded from the scenario title, a fresh alias table. Storage is **not** reset unless the scenario says `needs: ['reset']` |
| during | handles call the driver; fakes record; the Recorder accumulates |
| failure | the reporter attaches `server.debug()` output, the Recorder's invocations, the fakes' call logs and the telemetry sink to the test's annotations, after stripping `Authorization`, `CF-Access-*`, cookies and token values |
| `dispose()` | nothing is leaked across scenarios; under `http` the probe tenant's created resources are deleted or marked superseded |

Functional isolation (Farley): a scenario creates its own users, scopes and packs through the World and reads nothing it did not create; names are aliased per scenario so two scenarios creating `'acme'` never collide. The same mechanism lets scenarios share one storage within a file and lets the `http` driver run probes in parallel against one deployment. Temporal isolation: the fixed epoch means the same scenario produces the same timestamps each run.

Fixtures (`world.archive('gcp')`) are built from `tests/world/fixtures/<name>/` by the World at first use and cached per process; a fixture with a modification (`{ files: { 'pack.json': ... } }`) is built fresh. Archives are small (kilobytes), so there is no shared-fixture cost worth optimising beyond the cache.

## 7. The telemetry sink

Agreed with the monitoring plan: `docs/operations/monitoring.md` §8 (branch `claude/project-thread-bwothd`, unmerged; cited by path until it lands) is the source of truth for signal names, and a name used in a scenario that is not in that section is a bug in the scenario. The in-process driver exposes `world.telemetry`, a fake sink that captures logs, metrics and Analytics Engine writes made through the `Stats` and logging ports. A requirement that names a signal asserts it:

```ts
await expect(world.telemetry).toHaveRecorded('publish.validated', { verdict: 'pass' });
await expect(world.telemetry).toHaveRecorded('download', { pack: pack.name });
await expect(world.telemetry).not.toHaveRecorded('download', { ip: expect.stringMatching(/\d+\.\d+\.\d+\.\d+/) });  // REQ-TELEM-006
```

The sink is absent under `http`, so no `probe-safe` scenario asserts on it. Signal names in scenarios are the names from monitoring §8, never log lines or metric labels; when that section lands, the World's `TelemetrySink` type should import its name list so an unknown name is a type error.

## 8. The clock

`world.clock` is backed by the fake-clock Worker every production Worker reads through its `Clock` port. `advance('24h1m')` accepts `Nd Nh Nm Ns` combinations; `set('2026-03-01T00:00:00Z')` jumps; `now()` returns the current fake instant. Moving the clock fires nothing by itself: DO alarms, cron jobs and staging expiry are run explicitly (`world.cron.run(...)`, or the verb that would observe the consequence), so a scenario states every step. Workflow sleeps are disabled under test; a scenario that is about a sleep asserts the recorded sleep duration instead.

## 9. Example scenarios

All examples are drawn from the register; each names its requirement first. They are the target reading experience; the World is designed backwards from them. Every example passes the vocabulary and assertion-strength lint in [stability-checks.md](stability-checks.md) as written (`expect.any(Number)` appears only as a field inside `toMatchObject`).

```ts
// tests/scenarios/private/invisibility.scenario.ts
import { scenario, expect } from '@packserver/world';

scenario('REQ-PRIV-001 a private pack is indistinguishable from a nonexistent one', async (world) => {
  const owner = await world.publishers.create();
  const secret = await owner.publish(world.archive('gcp')).as('@acme/internal@1.0.0', { visibility: 'private' });
  await world.validation.completes(secret);

  const outsider = await world.users.create();
  await outsider.signIn();
  const agent = world.agents.anonymous();
  const nothing = world.packs.nonexistent('@acme/nope');

  await expect(world.visitor().open(secret.pack)).toBeNotFound();
  await expect(outsider.open(secret.pack)).toBeNotFound();
  await expect(agent.get(secret.pack)).toBeNotFound();
  await expect(agent.search('internal')).not.toContainPack(secret.pack);
  await expect(world.cn.repo().fetchIndex('acme')).not.toContainPack(secret.pack);
  expect(await world.visitor().open(secret.pack)).toLookTheSameAs(await world.visitor().open(nothing));
  await expect(outsider.star(secret.pack)).toBeNotFound();
});
```

```ts
// tests/scenarios/publishing/trusted-publishing.scenario.ts
scenario('REQ-PUB-004 a fork cannot publish through trusted publishing', async (world) => {
  const publisher = await world.publishers.create();
  const pack = await publisher.packs.reserve('@acme/gcp');
  await publisher.trustedPublishers.add(pack, { repo: 'acme/packs', workflowFile: 'publish.yml', path: 'packs/gcp' });
  const fork = world.github.workflow({ repo: 'mallory/packs', forkOf: 'acme/packs', workflowFile: 'publish.yml' });

  await expect(fork.publishes(pack, '1.0.0')).toBeRefusedWithClaimDiff({ repository: 'mallory/packs' });

  expect(await pack.versions()).toHaveLength(0);
  expect(await world.staging.objects()).toHaveLength(0);
  await expect(world.recorder.invocations({ effect: 'write' })).resolves.toHaveLength(0);
});
```

```ts
// tests/scenarios/payments/credits.scenario.ts
scenario('REQ-PAY-003 a failed validation consumes no credit', async (world) => {
  const publisher = await world.publishers.create();
  await publisher.credits.buy(1);

  const version = await publisher.publish(world.archive('with-secret')).as('@me/leaky@1.0.0');
  const run = await world.validation.completes(version);

  expect(await run.verdict()).toBe('fail');
  expect(await publisher.credits.balance()).toBe(1);
  await expect(world.stripe).not.toHaveBeenAsked();
  const finding = (await run.findings()).find(f => f.rule === 'secret');
  expect(finding).toMatchObject({ file: 'skills/deploy/SKILL.md', line: 12 });
  expect(finding).not.toHaveProperty('value');
});
```

```ts
// tests/scenarios/accounts/step-up.scenario.ts
scenario('REQ-ACC-010 minting a token needs a passkey assertion made for that very action', async (world) => {
  const publisher = await world.publishers.create();

  const minted = await publisher.tokens.mint({ scopes: ['publish:update'] });          // the verb asserts for itself
  expect(minted.plain).toMatch(/^pks_/);

  await expect(publisher.tokens.mint({ scopes: ['publish:update'], assertion: 'none' })).toBeRefused('step-up');
  await expect(publisher.tokens.mint({ scopes: ['publish:update'], assertion: 'replay' })).toBeRefused('step-up');
  const forAnotherAction = await publisher.assertionFor('account.delete');
  await expect(publisher.tokens.mint({ scopes: ['publish:update'], assertion: forAnotherAction })).toBeRefused('step-up');

  await world.clock.advance('1s');                                                    // no window: time changes nothing
  await expect(publisher.tokens.mint({ scopes: ['publish:update'], assertion: 'replay' })).toBeRefused('step-up');
  expect((await publisher.tokens.list())).toHaveLength(1);
  await expect(world.audit.for(publisher)).resolves.toContainAction('token.minted');
});
```

```ts
// tests/scenarios/moderation/yank.scenario.ts
scenario('REQ-MOD-011 REQ-DELIV-005 REQ-DELIV-008 a yanked version leaves latest and search but stays fetchable by exact version', async (world) => {
  const pack = await world.packs.public('@acme/gcp', { versions: ['1.0.0', '1.1.0'] });
  await pack.version('1.1.0').yank({ reason: 'breaks on Ant 2.3' });                 // the owner's per-action assertion is inside the verb

  const agent = world.agents.anonymous();
  const cn = world.cn.repo();

  expect((await agent.get(pack)).latest).toBe('1.0.0');
  expect((await cn.fetchIndex('acme')).entry(pack).latest).toBe('1.0.0');
  expect((await cn.fetchIndex('acme')).entry(pack).status).toBe('yanked');
  await expect(cn.fetchIndex('acme')).resolves.toHaveValidSignature();
  expect(await agent.download(pack, '1.1.0')).toMatchObject({ yanked: true, reason: 'breaks on Ant 2.3' });
  await expect(agent.search('gcp')).not.toContainVersion(pack, '1.1.0');
  await expect(world.visitor().open(pack)).resolves.toMatchObject({ latest: '1.0.0' });
});
```

```ts
// tests/scenarios/moderation/quarantine.scenario.ts
scenario('REQ-MOD-009 three independent malware reports quarantine a pack', async (world) => {
  const pack = await world.packs.public('@acme/gcp');
  const reporters = [
    await world.users.create({ ageDays: 8, via: 'github' }),
    await world.users.create({ ageDays: 30, via: 'passkey' }),
    await world.users.create({ ageDays: 8, via: 'email' }),
  ];
  for (const r of reporters) {
    await r.signIn();
    await r.reportAbuse(pack, { category: 'malware', details: `steals keys (${r.handle})` });
  }

  expect((await world.visitor().open(pack)).status).toBe('under_review');
  await expect(world.agents.anonymous().download(pack, '1.0.0')).toBeHeld();
  expect((await world.agents.anonymous().get(pack)).status).toBe('under_review');
  expect((await world.cn.repo().fetchIndex('acme')).entry(pack).status).toBe('quarantined');
  await expect(world.admins.notifications()).resolves.toContainEqual(expect.objectContaining({ pack: pack.name, kind: 'quarantine' }));
  await expect(world.telemetry).toHaveRecorded('moderation.quarantined', { trigger: 'reports' });
});

scenario('REQ-MOD-010 identical reports from one source collapse into one', async (world) => {
  const pack = await world.packs.public('@acme/gcp');
  const reporter = await world.users.create({ ageDays: 8 });
  await reporter.signIn();
  for (let i = 0; i < 3; i++) await reporter.reportAbuse(pack, { category: 'malware', details: 'steals keys' });

  expect((await world.visitor().open(pack)).status).toBe('active');
  expect((await world.admins.create()).queue.list()).resolves.toHaveLength(1);
});
```

```ts
// tests/scenarios/scopes/domain-proof.scenario.ts
scenario('REQ-SCOPE-004 REQ-SCOPE-006 a domain proof is earned by DNS TXT and lapses after a month of failed re-checks', async (world) => {
  const owner = await world.publishers.create();
  const org = await owner.orgs.create('acme');
  const challenge = await org.verifyDomain('acme.com');

  expect(await org.checkDomain()).toBe('not_found');
  world.dns.publishTxt('_packserver-challenge.acme.com', challenge.token);
  expect(await org.checkDomain()).toBe('verified');
  expect((await world.visitor().profile(org)).badges).toContainEqual({ kind: 'domain', host: 'acme.com' });

  world.dns.remove('_packserver-challenge.acme.com');
  await world.clock.advance('30d');
  await world.cron.run('domain-rechecks');
  expect((await world.visitor().profile(org)).badges).toContainEqual({ kind: 'domain', host: 'acme.com' });
  await expect(world.mail.inbox(owner)).resolves.toContainEmail({ about: 'domain verification' });

  await world.clock.advance('30d');
  await world.cron.run('domain-rechecks');
  expect((await world.visitor().profile(org)).badges).not.toContainEqual(expect.objectContaining({ kind: 'domain' }));
});
```

```ts
// tests/scenarios/search/agent-search.scenario.ts
scenario('REQ-SEARCH-003 an agent finds a pack by task phrasing and can narrow by category', async (world) => {
  const gcp = await world.packs.public('@acme/gcp-deploy', { summary: 'Deploy services to Google Cloud Run', categories: ['deploy'] });
  const aws = await world.packs.public('@acme/aws-lambda', { summary: 'Ship functions to AWS Lambda', categories: ['deploy'] });
  const lint = await world.packs.public('@acme/prettier-hooks', { summary: 'Format on save', categories: ['quality'] });
  const agent = world.agents.anonymous();

  const results = await agent.search('push my service to Cloud Run');
  expect(results.first()).toBePack(gcp);
  await expect(agent.search('push my service to Cloud Run', { category: 'quality' })).resolves.not.toContainPack(gcp);
  await expect(agent.search('format', { category: 'quality' })).resolves.toContainPack(lint);
  expect(results.card(gcp)).toMatchObject({ latest: '1.0.0', contextCost: expect.any(Number) });
  expect(results.card(gcp).summary.length).toBeLessThanOrEqual(1024);
}, { tags: ['agent'] });

scenario('REQ-SEARCH-004 agents do not see minutes-old versions unless they ask', async (world) => {
  const pack = await world.packs.public('@acme/gcp');                 // published at the epoch, long ago
  const owner = await pack.owner();
  const fresh = await owner.publish(world.archive('gcp', { version: '2.0.0' })).as('@acme/gcp@2.0.0');
  await world.validation.completes(fresh);
  const agent = world.agents.anonymous();

  expect((await agent.search('gcp')).card(pack).latest).toBe('1.0.0');
  expect((await agent.search('gcp', { includeFresh: true })).card(pack).latest).toBe('2.0.0');
  await world.clock.advance('24h');
  expect((await agent.search('gcp')).card(pack).latest).toBe('1.0.0');
  await world.clock.advance('1s');
  expect((await agent.search('gcp')).card(pack).latest).toBe('2.0.0');
}, { tags: ['agent'] });
```

```ts
// tests/scenarios/publishing/concurrency.scenario.ts
scenario('REQ-PUB-027 two concurrent publishes of one version produce one version and spend one credit', async (world) => {
  const publisher = await world.publishers.create({ credits: 2 });
  const archive = world.archive('gcp');

  const [first, second] = await Promise.allSettled([
    publisher.publish(archive).as('@me/gcp@1.0.0'),
    publisher.publish(archive).as('@me/gcp@1.0.0'),
  ]);
  const accepted = [first, second].filter(r => r.status === 'fulfilled');
  expect(accepted).toHaveLength(1);
  await world.validation.completes((accepted[0] as PromiseFulfilledResult<Version>).value);

  expect(await world.packs.get('@me/gcp').versions()).toHaveLength(1);        // same pack, one version
  expect(await publisher.credits.balance()).toBe(1);
});
```

```ts
// tests/scenarios/payments/webhooks.scenario.ts
scenario('REQ-PAY-004 a replayed payment event grants a credit once', async (world) => {
  const publisher = await world.publishers.create();
  const checkout = await publisher.credits.beginPurchase(5);
  const paid = world.stripe.event('checkout.session.completed', { session: checkout });

  await world.stripe.deliver(paid);
  await world.stripe.deliver(paid);                                  // Stripe retries with the same event id

  expect(await publisher.credits.balance()).toBe(5);
});

scenario('REQ-PAY-005 a payment event with a bad signature or a stale timestamp has no effect', async (world) => {
  const publisher = await world.publishers.create();
  const checkout = await publisher.credits.beginPurchase(5);
  const paid = world.stripe.event('checkout.session.completed', { session: checkout });

  await expect(world.stripe.deliver(paid, { signature: 'wrong' })).toBeRefused('signature');
  await world.clock.advance('301s');
  await expect(world.stripe.deliver(paid)).toBeRefused('signature');
  expect(await publisher.credits.balance()).toBe(0);
});
```

```ts
// tests/scenarios/accounts/sessions.scenario.ts
scenario('REQ-ACC-012 a revoked session loses sensitive actions at once and everything within a minute', async (world) => {
  const user = await world.users.create({ mfa: 'passkey' });
  const laptop = await user.signIn();
  const phone = await user.signIn();
  const pack = await world.packs.public('@acme/gcp');

  await user.as(laptop).sessions.revoke(phone);

  await expect(user.as(phone).tokens.mint({ read: pack })).toBeRefused('signed-out');   // sensitive: refused at once, assertion or not
  await world.clock.advance('60s');                                                     // the accepted propagation bound
  await expect(user.as(phone).inbox()).toBeRefused('signed-out');
  await expect(user.as(laptop).inbox()).resolves.toEqual([]);
  expect(await user.as(laptop).sessions.list()).toHaveLength(1);
});
```

The 60-second line is the bound the requirement states, moved with `world.clock`, never slept. In-process the local KV is strongly consistent, so the phone would in fact be refused before the clock moves; the scenario asserts only what is promised (refused *by* 60 s), which keeps it true on the deployed host too, where the delay is real.

```ts
// tests/scenarios/audit/record.scenario.ts
scenario('REQ-AUDIT-005 a tampered audit batch is caught by the published chain head', async (world) => {
  const publisher = await world.publishers.create();
  await publisher.tokens.mint({ scopes: ['publish:update'] });
  await world.cron.run('audit-head');

  const batches = await world.audit.batches();
  expect(batches.at(-1)?.previousHash).toBe(batches.at(-2)?.hash);
  await expect(world.rekor.entries()).resolves.toContainEqual(expect.objectContaining({ head: batches.at(-1)?.hash }));
  expect(await world.audit.verify()).toBe('intact');

  world.audit.tamper(batches[0], { alter: true });
  await world.cron.run('audit-verify');
  expect(await world.audit.verify()).toMatchObject({ mismatch: expect.objectContaining({ key: batches[0].key }) });
  await expect(world.admins.notifications()).resolves.toContainEqual(expect.objectContaining({ kind: 'audit-mismatch' }));
});
```

```ts
// tests/scenarios/operations/selftest.scenario.ts
scenario('REQ-OPS-005 REQ-OPS-006 a full self-test names the version that answered, and so does every response', async (world) => {
  const result = await world.operator.selfTest();

  expect(result.ok).toBe(true);
  expect(result.versionId).toBe(world.operator.deployedVersion());
  expect(result.checks).toContainEqual(expect.objectContaining({ name: 'config', ok: true, ms: expect.any(Number) }));
  await world.visitor().browse({ q: 'ping' });                                          // any ordinary response counts too
  expect(world.operator.observedVersions()).toEqual(new Set([world.operator.deployedVersion()]));
}, { tags: ['probe-safe'] });

scenario('REQ-OPS-007 a check that hangs is reported as failed inside the overall limit', async (world) => {
  world.operator.stall('outbound.github');

  const result = await world.operator.selfTest();

  expect(result.ok).toBe(false);
  expect(result.check('outbound.github')).toMatchObject({ ok: false, detail: 'timeout' });
  expect(result.check('outbound.github')?.ms).toBeLessThanOrEqual(2000);
  expect(result.check('config')).toMatchObject({ ok: true });
});

scenario('REQ-OPS-008 REQ-OPS-010 a self-test leaves no trace, and a shallow one never calls out', async (world) => {
  const before = await world.storage.fingerprint();

  await world.operator.selfTest();
  expect(await world.storage.fingerprint()).toBe(before);
  await expect(world.telemetry).not.toHaveRecorded('download');

  await world.operator.selfTest({ shallow: true });
  await expect(world.recorder.invocations({ kind: ['http', 'service'] })).resolves.toHaveLength(0);   // local bindings only
});

scenario('REQ-OPS-009 outsiders cannot spend the self-test budget', async (world) => {
  for (let i = 0; i < 20; i++) await expect(world.visitor().selfTest()).toBeNotFound();
  for (let i = 0; i < 10; i++) expect((await world.operator.selfTest({ shallow: true })).ok).toBe(true);

  await expect(world.operator.selfTest({ shallow: true })).toBeRateLimited();
});

scenario('REQ-OPS-011 a migration head outside the compiled range fails the self-test', async (world) => {
  await world.database.setMigrationHead(999);

  const result = await world.operator.selfTest();

  expect(result.ok).toBe(false);
  expect(result.check('schema')).toMatchObject({ ok: false, detail: expect.objectContaining({ head: 999 }) });
});
```

The self-test scenarios run under the `inprocess` driver, where `world.operator` holds the harness's probe identity; the first one is also `probe-safe` and runs against a deployed version as the release flow's pre-traffic check. `stall`, `storage.fingerprint`, `database.setMigrationHead` and the Recorder are in-process only, so the others carry no tag.

```ts
// tests/scenarios/delivery/download.scenario.ts
scenario('REQ-DELIV-001 a public download carries its hash and attestation', async (world) => {
  const probe = await world.probe.publisher();
  const version = await probe.publish(world.archive('gcp')).as('@probe/gcp@1.0.0');
  const download = await world.cn.repo().download(version.pack, '1.0.0');

  expect(download.sha256).toBe(await version.sha256());
  await expect(download.attestation()).resolves.toVerifyAgainst(world.registryKey());
}, { tags: ['probe-safe'] });

scenario('REQ-TELEM-001 a public download is counted', async (world) => {
  const pack = await world.packs.public('@acme/gcp');

  await world.cn.repo().download(pack, '1.0.0');

  await expect(world.telemetry).toHaveRecorded('download', { pack: pack.name, version: '1.0.0' });
});
```

The pair above is the shape the `probe-safe` lint enforces: the first scenario writes only as the probe publisher and touches no fake, clock or sink, so it runs against production; the telemetry assertion lives in a sibling without the tag.

```ts
// tests/scenarios/scopes/cross-scope.scenario.ts
scenario('REQ-SCOPE-016 a maintainer of one org cannot act on another org\'s pack', async (world) => {
  const acme = await world.packs.public('@acme/gcp');
  const rival = await (await world.publishers.create()).orgs.create('rival');
  const mallory = await world.users.create();
  await rival.invite(mallory).as('maintainer');
  await mallory.signIn();

  await expect(acme.as(mallory).version('1.0.0').yank({ reason: 'mine now' })).toBeRefused('forbidden');
  await expect(acme.as(mallory).access.grant(mallory)).toBeRefused('forbidden');
  expect(await acme.versions()).toHaveLength(1);
});
```

## 10. Anti-patterns the DSL refuses to grow

- A verb with a hidden assertion (`run.publishes()` throwing on a business refusal). Refusals are results; matchers assert.
- A mother per combination (`world.packs.publicWithTwoVersionsOneYanked()`). Builders take options; mothers are the handful of persona states the register names.
- A DSL method no scenario calls. `knip` over `tests/world` exports runs in the lint stage; dead verbs are deleted.
- Endpoint words leaking upward: a World method named after a route (`world.api.publish()`), a status code in a matcher name (`toBe404()`), a tool name in `Agent` (`agent.callTool('search_packs')`). The vocabulary lint applies to scenarios; review applies it to the World's public surface.
- Waiting: `await until(() => ...)` helpers that poll wall-clock. Conditions come from the harness (`waitForStatus`) or from the clock.
