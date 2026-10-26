import { expect, NotFound, Refusal, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const storage: ScenarioOpts = { needs: ["storage"] };

const FORBIDDEN_ACTIONS = ["publish", "yank", "mintToken", "setVisibility", "listSessions", "showAccount", "changeEmail", "approveStaged"] as const;
const LAPTOP = "198.51.100.7";

async function laptopLogin(world: World) {
  return world.member().signIn({ from: LAPTOP, country: "SE" });
}

const orgLookups = async (world: World) => (await world.recorder.invocations({ raw: true })).filter((i) => /memberships/.test(i.op ?? ""));

scenario("IT-PRIV-017 cn adopt on a laptop signs in with a device code; the token reads privately and ends with the session", async (world) => {
  const ann = await world.users.create({ handle: "ann", githubId: 1001 });
  const bob = await world.users.create({ handle: "bob", githubId: 2002 });
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  await world.access.allowAccount(secret, { id: 1001, login: "ann" });
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

const ALICE = { ownerId: 1001, repository: "alice/app", visibility: "private" } as const;
const OUTSIDER_REPO = { ownerId: 2002, repository: "mallory/app", visibility: "private" } as const;

/** `@acme/secret` allowlisting account 1001, and a second private pack nobody is allowlisted for. */
async function allowlisted(world: World) {
  const secret = await world.packs.public("@acme/secret", { visibility: "private", versions: ["1.0.0", "1.1.0"] });
  const other = await world.packs.public("@acme/other", { visibility: "private" });
  await world.access.allowAccount(secret, { id: 1001, login: "alice" });
  return { secret, other, ghost: world.packs.nonexistent("@acme/does-not-exist") };
}

/** The accounts and grants of earlier scenarios persist, so a list is read for the packs this scenario made. */
const among = (entries: ReadonlyArray<{ pack: string }>, ...packs: ReadonlyArray<{ systemName: string }>) =>
  entries.map((e) => e.pack).filter((name) => packs.some((p) => p.systemName === name)).sort();

const idOf = async (pack: { stored(version: string): Promise<{ versionId: string }> }, version = "1.0.0") => (await pack.stored(version)).versionId;

scenario("IT-PRIV-001 A private pack is indistinguishable from a nonexistent one", async (world) => {
  const { secret, ghost } = await allowlisted(world);
  const una = await world.users.create({ handle: "una", githubId: 4001 });
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
  const { secret, other, ghost } = await allowlisted(world);
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
    world.member().inActionsOf(ALICE, { token: "malformed" }),
    world.member().inActionsOf(ALICE, { token: "wrong-audience" }),
  ];
  for (const reads of credentials) {
    const asked = (pack: string) => reads.observe({ index: { pack } });
    const refused = await reads.index({ pack: secret.systemName });
    await expect(refused).toBeRefused("signed-out");
    await expect(asked(secret.systemName)).toLookTheSameAs(asked(ghost.systemName));
  }

  const without = [world.member().withToken(forOther), world.member().inActionsOf(OUTSIDER_REPO)];
  for (const reads of without) {
    await expect(reads.index({ pack: secret.systemName })).toBeNotFound();
    await expect(reads.observe({ index: { pack: secret.systemName } })).toLookTheSameAs(reads.observe({ index: { pack: ghost.systemName } }));
    await expect(reads.download(await idOf(secret))).toBeNotFound();
  }
}, storage);

scenario("IT-PRIV-015 Writes on a private pack look nonexistent to outsiders", async (world) => {
  const { secret, ghost } = await allowlisted(world);
  const una = await world.users.create({ handle: "una", githubId: 4015 });
  await una.signIn();

  const onSecret = await world.access.attemptWrites(una, secret);
  expect(onSecret).toEqual(await world.access.attemptWrites(una, ghost));
  expect(onSecret.every((o) => o.status >= 400 && o.status < 500)).toBe(true);
  expect(await world.reports.mine(una)).toEqual([]);
}, storage);

scenario("IT-PRIV-016 An allowlisted account's repositories read with the Actions token; the id is matched, not the login", async (world) => {
  const { secret, other } = await allowlisted(world);
  const version = await idOf(secret);
  const { canonicalSha256 } = await secret.stored("1.0.0");
  const orgPrivate = { ownerId: 3003, repository: "acme-org/app", visibility: "private" } as const;
  const orgPublic = { ownerId: 3003, repository: "acme-org/site", visibility: "public" } as const;

  const alice = world.member().inActionsOf(ALICE);
  const index = await alice.index();
  if (index instanceof NotFound || index instanceof Refusal) throw new Error("the allowlisted repository was refused");
  expect(among(index.entries, secret, other)).toEqual([secret.systemName]);
  const archive = await alice.download(version);
  expect(archive).toMatchObject({ sha256: canonicalSha256 });
  await expect(alice.download(await idOf(other))).toBeNotFound();

  await expect(world.member().inActionsOf(orgPrivate).index({ pack: secret.systemName })).toBeNotFound();
  await expect(world.member().inActionsOf(OUTSIDER_REPO).index({ pack: secret.systemName })).toBeNotFound();

  const renamed = world.member().inActionsOf({ ...ALICE, repository: "alice2/app" });
  expect(await renamed.index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });

  await world.access.allowAccount(secret, { id: 3003, login: "acme-org", type: "organization" });
  expect(await world.member().inActionsOf(orgPrivate).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
  await expect(world.member().inActionsOf(orgPublic).index({ pack: secret.systemName })).toBeNotFound();

  await world.access.allowAccount(secret, { id: 3003, login: "acme-org", type: "organization", privateReposOnly: false });
  expect(await world.member().inActionsOf(orgPublic).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
}, storage);

scenario("IT-PRIV-005 Revoking a grant takes effect at the next read", async (world) => {
  const { secret } = await allowlisted(world);
  const owner = await world.users.create({ handle: "ann", githubId: 5001 });
  await owner.signIn();
  await world.tokens.seedOwner(owner, secret);
  await owner.mfa.enrol();
  await world.access.allowAccount(secret, { id: 5001 });
  const token = await owner.tokens.mint({ read: secret });
  const reads = [world.member().inActionsOf(ALICE), world.member().signedInAs(owner)];
  for (const read of reads) expect(await read.index({ pack: secret.systemName })).toMatchObject({ headers: { "cache-control": "private, no-store" } });
  expect(await world.member().withToken(token).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });

  await world.access.disallowAccount(secret, { id: 1001 });
  await world.access.disallowAccount(secret, { id: 5001 });
  for (const read of reads) {
    await expect(read.index({ pack: secret.systemName })).toBeNotFound();
    await expect(read.download(await idOf(secret))).toBeNotFound();
  }
  await owner.tokens.revoke(token);
  await expect(world.member().withToken(token).index({ pack: secret.systemName })).toBeRefused("signed-out");
}, storage);

scenario("IT-PRIV-014 Maintainers manage grants; the data model's member role cannot", async (world) => {
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  const maintainer = await world.users.create({ handle: "mia" });
  const member = await world.users.create({ handle: "max" });
  await maintainer.signIn();
  await member.signIn();
  await world.reports.seedRole(secret, maintainer, "maintainer");
  await world.access.seedMember(secret, member);

  await expect(world.access.allowAccount(secret, { id: 2002 }, { by: member })).toBeRefused("forbidden");
  await expect(world.member().inActionsOf(OUTSIDER_REPO).index({ pack: secret.systemName })).toBeNotFound();
  await world.access.allowAccount(secret, { id: 2002 }, { by: maintainer });
  expect(await world.member().inActionsOf(OUTSIDER_REPO).index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
}, storage);

scenario("IT-PRIV-020 Private entries are signed by the validator and served as stored, never signed per request", async (world) => {
  const { secret, other } = await allowlisted(world);
  await world.access.allowAccount(other, { id: 1001 });
  const alice = world.member().inActionsOf(ALICE);

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

  const inbound = await world.member().inActionsOf({ ...OUTSIDER_REPO, ownerId: 8008 }).index();
  expect(inbound).toMatchObject({ entries: [] });
}, storage);

scenario("IT-DELIV-006 Private packs never appear in the public index; callers with access get the validator's signed entries", async (world) => {
  const { secret } = await allowlisted(world);
  await world.packs.public("@acme/open");
  const entries = async (reads: ReturnType<ReturnType<World["member"]>["inActionsOf"]>) => {
    const out = await reads.index();
    return out instanceof NotFound || out instanceof Refusal ? [] : among(out.entries, secret);
  };
  expect(await entries(world.member().inActionsOf(ALICE))).toEqual([secret.systemName]);
  expect(await entries(world.member().inActionsOf(OUTSIDER_REPO))).toEqual([]);
  await expect(world.member().inActionsOf(OUTSIDER_REPO).index({ pack: secret.systemName })).toBeNotFound();
  await expect(secret.read()).toBeNotFound();
}, storage);

scenario("IT-DELIV-007 Private bytes are served only after an access check, at an opaque id", async (world) => {
  const { secret } = await allowlisted(world);
  const id = await idOf(secret);
  const { canonicalSha256, objects } = await secret.stored("1.0.0");
  const archive = await world.member().inActionsOf(ALICE).download(id);
  expect(archive).toMatchObject({ sha256: canonicalSha256 });
  expect(id).not.toContain("secret");
  expect(objects).toEqual([]);

  const outsider = world.member().inActionsOf(OUTSIDER_REPO);
  await expect(outsider.download(id)).toBeNotFound();
  await expect(outsider.observe({ download: canonicalSha256 })).toLookTheSameAs(outsider.observe({ download: crypto.randomUUID() }));
  await expect(world.member().withToken("").download(id)).toBeRefused("signed-out");

  await secret.version("1.0.0").seed({ status: "quarantined", reason: "under review" });
  await expect(world.member().inActionsOf(ALICE).download(id)).toBeHeld();
}, storage);

scenario("IT-TELEM-008 Fetch records are kept 90 days and never identify a repository publicly", async (world) => {
  const { secret } = await allowlisted(world);
  const alice = world.member().inActionsOf(ALICE);
  await alice.download(await idOf(secret));
  expect(await world.access.fetches(secret)).toMatchObject([{ kind: "download", outcome: "served", accountId: "1001", repository: "alice/app" }]);

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
  const maintainer = await world.users.create({ handle: "mia" });
  await maintainer.signIn();
  await world.reports.seedRole(secret, maintainer, "maintainer");
  await world.access.allowAccount(secret, { id: 3003, login: "acme-org", type: "organization" }, { by: maintainer });
  const hosts = (await world.recorder.invocations({ raw: true })).map((i) => JSON.stringify(i));
  expect(hosts.filter((h) => /polar|stripe|paddle|paypal|payment/i.test(h))).toEqual([]);
}, storage);
