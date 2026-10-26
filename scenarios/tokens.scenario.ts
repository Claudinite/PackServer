import { expect, Refusal, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const storage: ScenarioOpts = { needs: ["storage"] };

const DAY_MS = 86_400_000;
const FORBIDDEN_ACTIONS = ["publish", "yank", "mintToken", "setVisibility", "listSessions", "showAccount", "changeEmail", "approveStaged"] as const;

/** An owner of `@acme` with two private packs, signed in, and a pack of another scope they have no part in. */
async function acme(world: World, handle = "ann") {
  const owner = await world.users.create({ handle });
  await owner.signIn();
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  const other = await world.packs.public("@acme/other-secret", { visibility: "private" });
  const elsewhere = await world.packs.public("@elsewhere/private", { visibility: "private" });
  await world.tokens.seedOwner(owner, secret);
  return { owner, secret, other, elsewhere };
}

scenario("IT-PUB-012 Mint scoped, restricted, time-limited read tokens shown once; no publish tokens exist", async (world) => {
  const { owner, secret } = await acme(world);

  await expect(owner.tokens.mint({ read: secret, assertion: "none" })).toBeRefused("step-up");
  expect(await owner.tokens.list()).toEqual([]);
  await owner.mfa.enrol();
  const forScope = await owner.assertionFor({ action: "token.mint", target: `@${world.alias("acme")}` });
  await expect(owner.tokens.mint({ read: secret, assertion: forScope })).toBeRefused("step-up");
  await expect(owner.tokens.mint({ read: secret, assertion: await owner.assertionFor("token.mint") })).toBeRefused("step-up");
  expect(await owner.tokens.list()).toEqual([]);

  const first = await owner.tokens.mint({ read: secret });
  expect(first.expiresAt.getTime() - (await world.clock.now()).getTime()).toBe(7 * DAY_MS);

  const scoped = await owner.tokens.mint({ readScope: "acme", cidr: ["10.0.0.0/8"] });
  expect((await owner.tokens.list()).find((t) => t.id === scoped.id)).toMatchObject({ pack: null, cidr: ["10.0.0.0/8"] });

  await expect(owner.tokens.mint({ read: secret, lifetimeDays: 366 })).toBeRefused("forbidden");
  const yearLong = await owner.tokens.mint({ read: secret, lifetimeDays: 365 });
  expect(yearLong.expiresAt.getTime() - (await world.clock.now()).getTime()).toBe(365 * DAY_MS);

  const listing = JSON.stringify(await owner.tokens.list());
  for (const minted of [first, scoped, yearLong]) expect(listing).not.toContain(minted.value);

  expect(await world.tokens.attempt(first, "mintToken", secret)).toBe("refused");
  expect(await owner.tokens.list()).toHaveLength(3);

  await expect(owner.tokens.mint({ read: secret, kind: "publish" })).toBeRefusedSaying("only read tokens exist");
  expect(await owner.tokens.list()).toHaveLength(3);
}, storage);

scenario("IT-PUB-013 A token works only within its scopes, restriction and CIDR", async (world) => {
  const { owner, secret, other } = await acme(world);
  const good = await owner.tokens.mint({ read: secret, cidr: ["10.0.0.0/8"] });
  const revoked = await owner.tokens.mint({ read: secret });
  await owner.tokens.revoke(revoked);
  const shortLived = await owner.tokens.mint({ read: secret, lifetimeDays: 1 });

  expect(await world.tokens.canRead(good, secret, { from: "10.1.2.3" })).toBe("readable");
  await expect(world.tokens.canRead(good, secret, { from: "192.0.2.1" })).toBeRefused("signed-out");
  await expect(world.tokens.canRead(good, other, { from: "10.1.2.3" })).toBeNotFound();
  await expect(world.tokens.canRead(revoked, secret)).toBeRefused("signed-out");
  expect(await world.tokens.canRead(shortLived, secret)).toBe("readable");

  await world.clock.advance("25h");
  await expect(world.tokens.canRead(shortLived, secret)).toBeRefused("signed-out");
  expect(await world.tokens.canRead(good, secret, { from: "10.1.2.3" })).toBe("readable");
}, storage);

scenario("IT-PUB-031 A token never acts beyond its scopes", async (world) => {
  const { owner, secret, elsewhere } = await acme(world);
  const token = await owner.tokens.mint({ read: secret });

  for (const action of FORBIDDEN_ACTIONS) expect(await world.tokens.attempt(token, action, secret), action).toBe("refused");
  await expect(world.tokens.canRead(token, elsewhere)).toBeNotFound();
  expect(await world.tokens.canRead(token, secret)).toBe("readable");
  expect(await owner.tokens.list()).toHaveLength(1);
}, storage);

scenario("IT-PUB-014 Tokens are prefixed and a leak report revokes at once", async (world) => {
  const { owner, secret } = await acme(world);
  const token = await owner.tokens.mint({ read: secret });
  expect(token.value.startsWith("psr_")).toBe(true);
  expect(await world.tokens.canRead(token, secret)).toBe("readable");

  await world.tokens.leakReport(token.value, { from: "203.0.113.14" });

  await expect(world.tokens.canRead(token, secret)).toBeRefused("signed-out");
  expect((await owner.tokens.list()).find((t) => t.id === token.id)).toMatchObject({ status: "revoked", revokedReason: "leak-reported" });
}, storage);

scenario("IT-PUB-032 Leak reports act on the full token only and reveal nothing", async (world) => {
  const { owner, secret } = await acme(world);
  const token = await owner.tokens.mint({ read: secret });
  const from = "203.0.113.32";

  const prefix = await world.tokens.leakReport(token.value.slice(0, 12), { from });
  expect(await world.tokens.canRead(token, secret)).toBe("readable");
  const random = await world.tokens.leakReport(`psr_${"0123456789abcdef".repeat(4)}`, { from });
  const full = await world.tokens.leakReport(token.value, { from });
  await expect(world.tokens.canRead(token, secret)).toBeRefused("signed-out");

  expect(prefix).not.toBeInstanceOf(Refusal);
  await expect(prefix).toLookTheSameAs(random);
  await expect(prefix).toLookTheSameAs(full);

  const burst = [];
  for (let i = 0; i < 20; i++) burst.push(await world.tokens.leakReport(`not-a-token-${i}`, { from }));
  expect(burst.some((report) => report instanceof Refusal)).toBe(true);
  await expect(burst.at(-1)).toBeRateLimited();
}, storage);

scenario("IT-AUDIT-006 Token last-used is visible and hourly-accurate", async (world) => {
  const { owner, secret } = await acme(world);
  const token = await owner.tokens.mint({ read: secret });
  const lastUsed = async () => (await owner.tokens.list()).find((t) => t.id === token.id)!.lastUsed?.getTime();

  const t0 = (await world.clock.now()).getTime();
  expect(await world.tokens.canRead(token, secret)).toBe("readable");
  expect(await lastUsed()).toBe(t0);

  await world.clock.advance("10m");
  expect(await world.tokens.canRead(token, secret)).toBe("readable");
  expect(await lastUsed()).toBe(t0);

  await world.clock.advance("1h");
  expect(await world.tokens.canRead(token, secret)).toBe("readable");
  expect(await lastUsed()).toBe(t0 + 70 * 60_000);
}, storage);

scenario("IT-PRIV-018 psr_ read tokens serve CI outside GitHub Actions", async (world) => {
  const { owner, secret, other } = await acme(world);
  const token = await owner.tokens.mint({ read: secret });

  expect(await world.tokens.canRead(token, secret)).toBe("readable");
  await expect(world.tokens.canRead(token, other)).toBeNotFound();
  const listed = await owner.tokens.list();
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ id: token.id, pack: secret.name, status: "active" });

  const ci = world.member().withToken(token);
  expect(await ci.index({ pack: secret.systemName })).toMatchObject({ entries: [{ pack: secret.systemName }] });
  expect(await ci.download((await secret.stored("1.0.0")).versionId)).toMatchObject({ sha256: (await secret.stored("1.0.0")).canonicalSha256 });
  await expect(ci.index({ pack: other.systemName })).toBeNotFound();
  await expect(ci.download((await other.stored("1.0.0")).versionId)).toBeNotFound();
}, storage);

scenario("JT-008 A psr_ read token serves CI outside Actions, is leaked, and dies at once", async (world) => {
  const { owner, secret, other } = await acme(world);
  const nowhere = world.packs.nonexistent("@acme/does-not-exist");

  await expect(owner.tokens.mint({ read: secret, assertion: "none" })).toBeRefused("step-up");
  expect(await owner.tokens.list()).toEqual([]);
  const token = await owner.tokens.mint({ read: secret });
  expect(token.value.startsWith("psr_")).toBe(true);
  expect(JSON.stringify(await owner.tokens.list())).not.toContain(token.value);

  const t0 = (await world.clock.now()).getTime();
  expect(await world.tokens.canRead(token, secret)).toBe("readable");
  await world.clock.advance("10m");
  expect(await world.tokens.canRead(token, secret)).toBe("readable");
  expect((await owner.tokens.list())[0]!.lastUsed?.getTime()).toBe(t0);

  await expect(world.tokens.canRead(token, other)).toBeNotFound();
  expect(await world.tokens.attempt(token, "publish", secret)).toBe("refused");

  const from = "203.0.113.88";
  const prefix = await world.tokens.leakReport(token.value.slice(0, 12), { from });
  const random = await world.tokens.leakReport("psr_not-a-token", { from });
  const full = await world.tokens.leakReport(token.value, { from });
  await expect(prefix).toLookTheSameAs(random);
  await expect(prefix).toLookTheSameAs(full);

  await expect(world.tokens.canRead(token, secret)).toBeRefused("signed-out");
  expect(await world.tokens.canRead(token, nowhere)).toEqual(await world.tokens.canRead(token, secret));
  expect((await owner.tokens.list())[0]).toMatchObject({ status: "revoked", revokedReason: "leak-reported" });
}, storage);
