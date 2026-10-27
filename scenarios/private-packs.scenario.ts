import { expect, NotFound, Refusal, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const storage: ScenarioOpts = { needs: ["storage"] };

const FORBIDDEN_ACTIONS = ["publish", "yank", "mintToken", "setVisibility", "listSessions", "showAccount", "changeEmail", "approveStaged"] as const;
const LAPTOP = "198.51.100.7";

async function laptopLogin(world: World) {
  return world.member().signIn({ from: LAPTOP, country: "SE" });
}

const orgLookups = async (world: World) => (await world.recorder.invocations({ raw: true })).filter((i) => /memberships/.test(i.op ?? ""));

scenario("IT-PRIV-017 cn adopt on a laptop signs in with a device code; the token reads privately and ends with the session", async (world) => {
  const annAccount = world.access.account("ann");
  const ann = await world.users.create({ handle: "ann", githubId: annAccount.id });
  const bob = await world.users.create({ handle: "bob", githubId: world.access.account("bob").id });
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  await world.access.allowAccount(secret, annAccount);
  const member = world.member();

  const first = await laptopLogin(world);
  expect(first.link).not.toContain(first.userCode);
  expect(first.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  expect(await first.poll()).toEqual({ status: "pending" });
  expect(await first.poll()).toEqual({ status: "slow-down" });

  await ann.signIn();
  await bob.signIn();
  const lookupsAtSignIn = await orgLookups(world);
  const confirmation = String((await ann.deviceSignIn.enter(first.userCode)).body);
  expect(confirmation).toContain("Sweden");
  expect(confirmation).toContain("read the private packs you are allowed to read");
  expect(confirmation).not.toContain(LAPTOP);
  await world.clock.advance("11s");
  expect(await first.poll()).toEqual({ status: "pending" });

  await ann.deviceSignIn.allow(first.userCode);
  await world.clock.advance("11s");
  const granted = await first.poll();
  expect(granted.status).toBe("granted");
  if (granted.status !== "granted") return;
  expect(await first.poll()).toEqual({ status: "invalid" });

  expect(await member.grantOf(granted.token)).toMatchObject({ grants: ["private-reads"] });
  for (const action of FORBIDDEN_ACTIONS) expect(await world.tokens.attempt(granted.token.value, action, secret), action).toBe("refused");

  const reads = member.withToken(granted.token);
  const version = (await secret.stored("1.0.0")).versionId;
  expect(await reads.index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
  expect(await reads.download(version)).toMatchObject({ sha256: (await secret.stored("1.0.0")).canonicalSha256 });
  expect(await member.signedInAs(ann).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
  await expect(member.signedInAs(bob).download(version)).toBeNotFound();
  const bobs = await laptopLogin(world);
  await bob.deviceSignIn.allow(bobs.userCode);
  await world.clock.advance("11s");
  const bobGrant = await bobs.poll();
  if (bobGrant.status !== "granted") throw new Error("the second person was not granted a token");
  await expect(member.withToken(bobGrant.token).index({ pack: secret.systemName })).toBeNotFound();
  await expect(member.withToken(bobGrant.token).download(version)).toBeNotFound();
  expect(await orgLookups(world)).toEqual(lookupsAtSignIn);

  const denied = await laptopLogin(world);
  await ann.deviceSignIn.deny(denied.userCode);
  await world.clock.advance("11s");
  expect(await denied.poll()).toEqual({ status: "denied" });

  const unanswered = await laptopLogin(world);
  await world.clock.advance("16m");
  expect(await unanswered.poll()).toEqual({ status: "expired" });
  expect(String((await ann.deviceSignIn.enter(unanswered.userCode)).body)).not.toContain("Sweden");

  await world.clock.advance("169h");
  await expect(member.grantOf(granted.token)).toBeRefused("signed-out");
  await expect(reads.index({ pack: secret.systemName })).toBeRefused("signed-out");

  await ann.signIn();
  const last = await laptopLogin(world);
  await ann.deviceSignIn.allow(last.userCode);
  await world.clock.advance("11s");
  const lastGrant = await last.poll();
  expect(lastGrant.status).toBe("granted");
  if (lastGrant.status !== "granted") return;
  expect(await member.grantOf(lastGrant.token)).toMatchObject({ grants: ["private-reads"] });
  await ann.signOut();
  await expect(member.grantOf(lastGrant.token)).toBeRefused("signed-out");
}, storage);

/** `@acme/secret` allowlisting alice's account, a second private pack nobody is allowlisted for, and a repository outside the allowlist. */
async function allowlisted(world: World) {
  const secret = await world.packs.public("@acme/secret", { visibility: "private", versions: ["1.0.0", "1.1.0"] });
  const other = await world.packs.public("@acme/other", { visibility: "private" });
  const aliceAccount = world.access.account("alice");
  await world.access.allowAccount(secret, aliceAccount);
  return {
    secret,
    other,
    ghost: world.packs.nonexistent("@acme/does-not-exist"),
    aliceAccount,
    aliceRepo: world.access.repository(aliceAccount, "app"),
    outsiderRepo: world.access.repository(world.access.account("mallory"), "app"),
  };
}

/** The accounts and grants of earlier scenarios persist, so a list is read for the packs this scenario made. */
const among = (entries: ReadonlyArray<{ pack: string }>, ...packs: ReadonlyArray<{ systemName: string }>) =>
  entries.map((e) => e.pack).filter((name) => packs.some((p) => p.systemName === name)).sort();

const idOf = async (pack: { stored(version: string): Promise<{ versionId: string }> }, version = "1.0.0") => (await pack.stored(version)).versionId;

scenario("IT-PRIV-001 A private pack is indistinguishable from a nonexistent one", async (world) => {
  const { secret, ghost } = await allowlisted(world);
  const una = await world.users.create({ handle: "una", githubId: world.access.account("una").id });
  await una.signIn();
  const { canonicalSha256, objects } = await secret.stored("1.0.0");

  await expect(secret.read()).toBeNotFound();
  await expect(secret.observe()).toLookTheSameAs(ghost.observe());
  expect(await world.packs.verify(canonicalSha256)).toEqual({ result: "unknown" });
  expect(objects).toEqual([]);

  for (const reads of [world.member().signedInAs(una), world.member().withToken("")]) {
    const asked = (pack: string) => reads.observe({ index: { pack } });
    await expect(asked(secret.systemName)).toLookTheSameAs(asked(ghost.systemName));
  }
  const download = (id: string) => world.member().signedInAs(una).observe({ download: id });
  await expect(download(await idOf(secret))).toLookTheSameAs(download(crypto.randomUUID()));

  const agent = world.agents.anonymous();
  const shaped = async (pack: typeof secret) => JSON.stringify((await agent.pack(pack)).body).replaceAll(pack.systemName, "<pack>");
  expect(await shaped(secret)).toBe(await shaped(ghost));
  expect(JSON.stringify((await agent.search("secret")).body)).not.toContain(secret.systemName);
}, storage);

scenario("IT-PRIV-002 Invalid credentials are refused without revealing existence; a valid one without access reads as nonexistent", async (world) => {
  const { secret, other, ghost, aliceRepo, outsiderRepo } = await allowlisted(world);
  const owner = await world.users.create({ handle: "ann" });
  await owner.signIn();
  await world.tokens.seedOwner(owner, secret);
  await owner.mfa.enrol();
  const expiring = await owner.tokens.mint({ read: secret, lifetimeDays: 1 });
  const revoked = await owner.tokens.mint({ read: secret });
  await owner.tokens.revoke(revoked);
  const forOther = await owner.tokens.mint({ read: other });
  await world.clock.advance("25h");

  const credentials = [
    world.member().withToken(expiring),
    world.member().withToken(revoked),
    world.member().withToken("garbage"),
    world.member().inActionsOf(aliceRepo, { token: "malformed" }),
    world.member().inActionsOf(aliceRepo, { token: "wrong-audience" }),
  ];
  for (const reads of credentials) {
    const asked = (pack: string) => reads.observe({ index: { pack } });
    const refused = await reads.index({ pack: secret.systemName });
    await expect(refused).toBeRefused("signed-out");
    await expect(asked(secret.systemName)).toLookTheSameAs(asked(ghost.systemName));
  }

  const without = [world.member().withToken(forOther), world.member().inActionsOf(outsiderRepo)];
  for (const reads of without) {
    await expect(reads.index({ pack: secret.systemName })).toBeNotFound();
    await expect(reads.observe({ index: { pack: secret.systemName } })).toLookTheSameAs(reads.observe({ index: { pack: ghost.systemName } }));
    await expect(reads.download(await idOf(secret))).toBeNotFound();
  }
}, storage);

scenario("IT-PRIV-015 Writes on a private pack look nonexistent to outsiders", async (world) => {
  const { secret, ghost } = await allowlisted(world);
  const una = await world.users.create({ handle: "una", githubId: world.access.account("una").id });
  await una.signIn();

  const onSecret = await world.access.attemptWrites(una, secret);
  expect(onSecret).toEqual(await world.access.attemptWrites(una, ghost));
  expect(onSecret.every((o) => o.status >= 400 && o.status < 500)).toBe(true);
  expect(await world.reports.mine(una)).toEqual([]);
}, storage);

scenario("IT-PRIV-016 An allowlisted account's repositories read with the Actions token; the id is matched, not the login", async (world) => {
  const { secret, other, aliceRepo, outsiderRepo } = await allowlisted(world);
  const version = await idOf(secret);
  const { canonicalSha256 } = await secret.stored("1.0.0");
  const org = world.access.account("acme-org", { type: "organization" });
  const orgPrivate = world.access.repository(org, "app");
  const orgPublic = world.access.repository(org, "site", "public");

  const alice = world.member().inActionsOf(aliceRepo);
  const index = await alice.index();
  if (index instanceof NotFound || index instanceof Refusal) throw new Error("the allowlisted repository was refused");
  expect(among(index.entries, secret, other)).toEqual([secret.systemName]);
  const archive = await alice.download(version);
  expect(archive).toMatchObject({ sha256: canonicalSha256 });
  await expect(alice.download(await idOf(other))).toBeNotFound();

  await expect(world.member().inActionsOf(orgPrivate).index({ pack: secret.systemName })).toBeNotFound();
  await expect(world.member().inActionsOf(outsiderRepo).index({ pack: secret.systemName })).toBeNotFound();

  const renamed = world.member().inActionsOf({ ...aliceRepo, repository: "alice2/app" });
  expect(await renamed.index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });

  await world.access.allowAccount(secret, org);
  expect(await world.member().inActionsOf(orgPrivate).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
  await expect(world.member().inActionsOf(orgPublic).index({ pack: secret.systemName })).toBeNotFound();

  await world.access.allowAccount(secret, { ...org, privateReposOnly: false });
  expect(await world.member().inActionsOf(orgPublic).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
}, storage);

scenario("IT-PRIV-005 Revoking a grant takes effect at the next read", async (world) => {
  const { secret, aliceRepo, aliceAccount } = await allowlisted(world);
  const ownerAccount = world.access.account("ann");
  const owner = await world.users.create({ handle: "ann", githubId: ownerAccount.id });
  await owner.signIn();
  await world.tokens.seedOwner(owner, secret);
  await owner.mfa.enrol();
  await world.access.allowAccount(secret, ownerAccount);
  const token = await owner.tokens.mint({ read: secret });
  const reads = [world.member().inActionsOf(aliceRepo), world.member().signedInAs(owner)];
  for (const read of reads) expect(await read.index({ pack: secret.systemName })).toMatchObject({ headers: { "cache-control": "private, no-store" } });
  expect(await world.member().withToken(token).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });

  await world.access.disallowAccount(secret, aliceAccount);
  await world.access.disallowAccount(secret, ownerAccount);
  for (const read of reads) {
    await expect(read.index({ pack: secret.systemName })).toBeNotFound();
    await expect(read.download(await idOf(secret))).toBeNotFound();
  }
  await owner.tokens.revoke(token);
  await expect(world.member().withToken(token).index({ pack: secret.systemName })).toBeRefused("signed-out");
}, storage);

scenario("IT-PRIV-020 Private entries are signed by the validator and served as stored, never signed per request", async (world) => {
  const { secret, other, aliceRepo, outsiderRepo, aliceAccount } = await allowlisted(world);
  await world.access.allowAccount(other, aliceAccount);
  const alice = world.member().inActionsOf(aliceRepo);

  const first = await alice.index();
  const second = await alice.index();
  const third = await alice.index();
  if (first instanceof NotFound || first instanceof Refusal || second instanceof NotFound || second instanceof Refusal || third instanceof NotFound || third instanceof Refusal) {
    throw new Error("the allowlisted repository was refused");
  }
  expect([second.raw, third.raw]).toEqual([first.raw, first.raw]);
  expect(first.envelope).toMatchObject({ private: true, storable: false });
  expect(first.headers["cache-control"]).toBe("private, no-store");
  expect(among(first.entries, secret, other)).toEqual([other.systemName, secret.systemName].sort());
  for (const entry of first.entries) {
    expect(entry).toMatchObject({ kind: "private", serial: 1 });
    expect(await world.access.verifies(entry)).toBe(true);
  }

  await secret.version("1.0.0").seed({ status: "deprecated", reason: "superseded" });
  const after = await alice.index({ pack: secret.systemName });
  if (after instanceof NotFound || after instanceof Refusal) throw new Error("the allowlisted repository was refused");
  expect(after.entries[0]).toMatchObject({ serial: 2, versions: expect.arrayContaining([expect.objectContaining({ version: "1.0.0", status: "deprecated" })]) });
  const untouched = await alice.index({ pack: other.systemName });
  if (untouched instanceof NotFound || untouched instanceof Refusal) throw new Error("the allowlisted repository was refused");
  expect(untouched.entries[0]).toMatchObject({ serial: 1 });

  const inbound = await world.member().inActionsOf(outsiderRepo).index();
  expect(inbound).toMatchObject({ entries: [] });
}, storage);

scenario("IT-DELIV-006 Private packs never appear in the public index; callers with access get the validator's signed entries", async (world) => {
  const { secret, aliceRepo, outsiderRepo } = await allowlisted(world);
  await world.packs.public("@acme/open");
  const entries = async (reads: ReturnType<ReturnType<World["member"]>["inActionsOf"]>) => {
    const out = await reads.index();
    return out instanceof NotFound || out instanceof Refusal ? [] : among(out.entries, secret);
  };
  expect(await entries(world.member().inActionsOf(aliceRepo))).toEqual([secret.systemName]);
  expect(await entries(world.member().inActionsOf(outsiderRepo))).toEqual([]);
  await expect(world.member().inActionsOf(outsiderRepo).index({ pack: secret.systemName })).toBeNotFound();
  await expect(secret.read()).toBeNotFound();
}, storage);

scenario("IT-DELIV-007 Private bytes are served only after an access check, at an opaque id", async (world) => {
  const { secret, aliceRepo, outsiderRepo } = await allowlisted(world);
  const id = await idOf(secret);
  const { canonicalSha256, objects } = await secret.stored("1.0.0");
  const archive = await world.member().inActionsOf(aliceRepo).download(id);
  expect(archive).toMatchObject({ sha256: canonicalSha256 });
  expect(id).not.toContain("secret");
  expect(objects).toEqual([]);

  const outsider = world.member().inActionsOf(outsiderRepo);
  await expect(outsider.download(id)).toBeNotFound();
  await expect(outsider.observe({ download: canonicalSha256 })).toLookTheSameAs(outsider.observe({ download: crypto.randomUUID() }));
  await expect(world.member().withToken("").download(id)).toBeRefused("signed-out");

  await secret.version("1.0.0").seed({ status: "quarantined", reason: "under review" });
  await expect(world.member().inActionsOf(aliceRepo).download(id)).toBeHeld();
}, storage);

scenario("IT-TELEM-008 Fetch records are kept 90 days and never identify a repository publicly", async (world) => {
  const { secret, aliceRepo, aliceAccount } = await allowlisted(world);
  const alice = world.member().inActionsOf(aliceRepo);
  await alice.download(await idOf(secret));
  expect(await world.access.fetches(secret)).toMatchObject([{ kind: "download", outcome: "served", accountId: String(aliceAccount.id), repository: "alice/app" }]);

  await world.clock.advance("89d");
  expect(await world.access.fetches(secret)).toHaveLength(1);
  await world.clock.advance("48h");
  await alice.index();
  const left = await world.access.fetches(secret);
  expect(left.map((f) => f.kind)).toEqual(["index"]);

  const agent = world.agents.anonymous();
  expect(JSON.stringify((await agent.pack(secret)).body)).not.toContain("alice");
  await expect(secret.read()).toBeNotFound();
}, storage);

scenario("IT-PAY-018 A grant on a private pack asks for no payment", async (world) => {
  const { secret } = await allowlisted(world);
  await world.access.allowAccount(secret, world.access.account("acme-org", { type: "organization" }));
  const hosts = (await world.recorder.invocations({ raw: true })).map((i) => JSON.stringify(i));
  expect(hosts.filter((h) => /polar|stripe|paddle|paypal|payment/i.test(h))).toEqual([]);
}, storage);

scenario("IT-PRIV-019 Changing the allowlist needs a passkey and is audited", async (world) => {
  const ann = await world.publishers.create({ handle: "ann" });
  await ann.orgs.create("acme");
  const secret = await world.packs.public("@acme/secret", { visibility: "private", versions: ["1.0.0", "1.1.0"] });
  const bob = world.access.account("bob");
  const bobRepo = world.access.repository(bob, "app");
  const manage = world.access.manage(secret, ann);
  const reads = world.member().inActionsOf(bobRepo);

  await expect(manage.allow(bob, { assertion: "none" })).toBeRefused("step-up");
  await expect(reads.index({ pack: secret.systemName })).toBeNotFound();
  expect((await manage.view())).toMatchObject({ grants: [] });

  await manage.allow(bob);
  expect(await reads.index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });

  await world.clock.advance("1m");
  await expect(manage.remove(bob, { assertion: "none" })).toBeRefused("step-up");
  expect(await reads.index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
  await manage.remove(bob);
  await expect(reads.index({ pack: secret.systemName })).toBeNotFound();

  const trail = (await ann.account.history()).filter((e) => e.action === "grant.changed");
  expect(trail.map((e) => e.target).sort()).toEqual([`${secret.systemName}#${bob.id}`, `${secret.systemName}#${bob.id}`]);
  expect(await manage.view()).toMatchObject({ changes: [{ change: "removed", accountId: String(bob.id), actor: ann.handle }, { change: "added", accountId: String(bob.id), actor: ann.handle }] });
}, storage);

scenario("IT-PRIV-012 Grant changes are audited and shown on the access page", async (world) => {
  const ann = await world.publishers.create({ handle: "ann" });
  const acme = await ann.orgs.create("acme");
  const secret = await world.packs.public("@acme/secret", { visibility: "private", versions: ["1.0.0", "1.1.0"] });
  const bob = world.access.account("bob");
  const bobRepo = world.access.repository(bob, "app");
  const manage = world.access.manage(secret, ann);
  const carol = world.access.account("carol");
  const rival = await world.publishers.create({ handle: "rival" });
  await rival.orgs.create("elsewhere");
  const visitor = await world.users.create({ handle: "visitor" });

  await manage.allow(bob);
  await world.clock.advance("1m");
  await manage.allow(carol);
  await world.clock.advance("1m");
  await manage.remove(carol);
  const reads = world.member().inActionsOf(bobRepo);
  await reads.index({ pack: secret.systemName });
  await reads.download(await idOf(secret));

  const view = await manage.view();
  if (view instanceof NotFound) throw new Error("the owner was not shown the access page");
  expect(view.you).toBe("owner");
  expect(view.grants).toMatchObject([{ accountId: String(bob.id), addedBy: ann.handle }]);
  expect(view.grants[0]?.lastFetchAt).not.toBeNull();
  expect(view.changes.map((c) => `${c.change}:${c.accountId}`)).toEqual([`removed:${carol.id}`, `added:${carol.id}`, `added:${bob.id}`]);
  expect(view.fetches.map((f) => [f.kind, f.outcome, f.accountId, f.repository]).sort()).toEqual([
    ["download", "served", String(bob.id), "bob/app"],
    ["index", "served", String(bob.id), "bob/app"],
  ]);

  const visit = await manage.page();
  if (visit instanceof NotFound || visit.kind !== "page") throw new Error("the owner was not shown the access page");
  for (const wanted of [String(bob.id), String(carol.id), "bob/app", `by @${ann.handle}`, "Denied attempts"]) expect(visit.text).toContain(wanted);

  await expect(world.access.manage(secret, rival).view()).toBeNotFound();
  await expect(world.access.manage(secret, rival).page()).toBeNotFound();
  await expect(world.access.manage(secret, visitor).view()).toBeRefused("signed-out");
  expect(await world.access.manage(secret, visitor).page()).toEqual({ kind: "sign-in", next: expect.stringContaining("/access") });
  await visitor.signIn();
  await expect(world.access.manage(secret, visitor).page()).toBeNotFound();

  const agent = world.agents.anonymous();
  expect(JSON.stringify((await agent.pack(secret)).body)).not.toContain("bob");
  expect(JSON.stringify((await agent.search("secret")).body)).not.toContain("bob/app");
  expect(await acme.people()).toMatchObject({ you: "owner" });
  expect(ann.handle).toBe("ann");
}, storage);

scenario("IT-PRIV-014 Maintainers manage grants; a person with no role in the org cannot", async (world) => {
  const ann = await world.publishers.create({ handle: "ann" });
  const acme = await ann.orgs.create("acme");
  const secret = await world.packs.public("@acme/secret", { visibility: "private", versions: ["1.0.0", "1.1.0"] });
  const bob = world.access.account("bob");
  const bobRepo = world.access.repository(bob, "app");
  const maintainer = await world.publishers.create({ handle: "mia" });
  const outsider = await world.publishers.create({ handle: "xavier" });
  await acme.invite(maintainer).as("maintainer");
  const [offered] = await world.invitations.pending(maintainer);
  await world.invitations.accept(maintainer, { id: offered!.id });

  await expect(world.access.manage(secret, outsider).allow(bob)).toBeNotFound();
  await expect(world.member().inActionsOf(bobRepo).index({ pack: secret.systemName })).toBeNotFound();

  await world.access.manage(secret, maintainer).allow(bob);
  expect(await world.member().inActionsOf(bobRepo).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
  expect(await world.access.manage(secret, maintainer).view()).toMatchObject({ you: "maintainer", grants: [{ accountId: String(bob.id), addedBy: maintainer.handle }] });
}, storage);

scenario("IT-PRIV-010 Making a pack public needs an assertion and a confirmation, and is permanent", async (world) => {
  const ann = await world.publishers.create({ handle: "ann" });
  await ann.orgs.create("acme");
  await ann.orgs.create("vault");
  await world.access.seedRegistryKeys();
  const draft = await world.packs.public("@acme/draft", { visibility: "private", versions: [] });
  const pending = await world.packs.public("@acme/pending", { visibility: "private", versions: [] });
  const secret = await world.packs.public("@vault/secret", { visibility: "private", versions: ["1.0.0"] });
  const stored = await secret.stored("1.0.0");

  const bare = world.access.manage(draft, ann);
  await expect(bare.setVisibility("public", { assertion: "none", confirmed: true })).toBeRefused("step-up");
  await expect(bare.setVisibility("public")).toBeRefused("forbidden");
  expect(await bare.view()).toMatchObject({ visibility: "private", published: false });
  const before = await world.registry.serial(draft);
  await bare.setVisibility("public", { confirmed: true });
  await world.registry.indexes(draft, { newerThan: before });
  expect(await bare.view()).toMatchObject({ visibility: "public" });
  const between = await world.registry.serial(draft);
  await bare.setVisibility("private");
  await world.registry.indexes(draft, { newerThan: between });
  expect(await bare.view()).toMatchObject({ visibility: "private" });
  const trail = (await ann.account.history()).filter((e) => e.action === "visibility.changed");
  expect(trail.map((e) => e.target)).toEqual([draft.systemName, draft.systemName]);

  await world.access.seedPendingVersion(pending);
  const midway = world.access.manage(pending, ann);
  await expect(midway.setVisibility("public", { confirmed: true })).toBeRefused("exists");
  expect(await midway.view()).toMatchObject({ visibility: "private", published: true });

  const published = world.access.manage(secret, ann);
  const serial = await world.registry.serial(secret);
  await expect(published.setVisibility("public", { confirmed: true })).toBeRefused("exists");
  expect(await published.view()).toMatchObject({ visibility: "private", published: true });
  expect((await secret.stored("1.0.0")).objects).toEqual(stored.objects);
  expect(await world.registry.serial(secret)).toBe(serial);
}, storage);

scenario("IT-PUB-022 Only owners change a pack's visibility or offer it to another scope", async (world) => {
  const ann = await world.publishers.create({ handle: "ann" });
  const acme = await ann.orgs.create("acme");
  const secret = await world.packs.public("@acme/secret", { visibility: "private", versions: [] });
  const manage = world.access.manage(secret, ann);
  const maintainer = await world.publishers.create({ handle: "mia" });
  await acme.invite(maintainer).as("maintainer");
  const [offered] = await world.invitations.pending(maintainer);
  await world.invitations.accept(maintainer, { id: offered!.id });
  const target = await (await world.publishers.create({ handle: "w" })).orgs.create("target");

  const asMaintainer = world.access.manage(secret, maintainer);
  await expect(asMaintainer.setVisibility("public", { confirmed: true })).toBeRefused("forbidden");
  expect(await manage.view()).toMatchObject({ visibility: "private" });

  await manage.setVisibility("public", { confirmed: true });
  await expect(asMaintainer.setVisibility("private")).toBeRefused("forbidden");
  await expect(world.transfers.offer(secret, { to: target, by: maintainer })).toBeRefused("forbidden");
  expect(await manage.view()).toMatchObject({ visibility: "public" });
  await world.transfers.offer(secret, { to: target, by: ann });
}, storage);

scenario("IT-PRIV-011 A pack with published versions keeps them where they are when its visibility is asked to change", async (world) => {
  const ann = await world.publishers.create({ handle: "ann" });
  await ann.orgs.create("acme");
  await world.access.seedRegistryKeys();
  const open = await world.packs.public("@acme/open", { versions: ["1.0.0"] });
  const manage = world.access.manage(open, ann);
  const before = await open.stored("1.0.0");
  const serial = await world.registry.serial(open);
  expect(before.objects.length).toBeGreaterThan(0);

  await expect(manage.setVisibility("private")).toBeRefused("exists");

  expect(await manage.view()).toMatchObject({ visibility: "public", published: true });
  const after = await open.stored("1.0.0");
  expect(after.objects).toEqual(before.objects);
  expect(after.canonicalSha256).toBe(before.canonicalSha256);
  expect(await world.packs.verify(before.canonicalSha256)).toMatchObject({ result: "canonical" });
  expect(await world.registry.serial(open)).toBe(serial);
}, storage);
