import { expect, Refusal, scenario, type User, type World } from "@packserver/test-world";

const RESERVED = ["admin", "claude", "anthropic", "claudinite", "cn", "fleet", "local", "global", "canon", "temp"];

type Attempt = "ok" | "rate-limited";

/** Runs the attempts in order; a refusal for rate-limiting is a result, anything else is a failure of the test. */
async function outcomes(attempts: Array<() => Promise<unknown>>): Promise<Attempt[]> {
  const out: Attempt[] = [];
  for (const attempt of attempts) {
    out.push(await attempt().then(
      () => "ok" as const,
      (error: unknown) => {
        if (error instanceof Refusal && error.reason === "rate-limited") return "rate-limited" as const;
        throw error;
      },
    ));
  }
  return out;
}

/** The most sign-in attempts one address or account may make before a refusal, with room for the cost-6 / 60 per minute design. */
const MOST_ATTEMPTS_ALLOWED = 20;

/** Refused "after N", never an exact N; the limit's window may roll over mid-run, so only the refusal's first step is held to staying refused. */
function expectRefusedAfterSome(results: Attempt[]): void {
  const first = results.indexOf("rate-limited");
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(MOST_ATTEMPTS_ALLOWED);
  expect(results[first + 1] ?? "rate-limited").toBe("rate-limited");
}

const signUps = (world: World, count: number, via: (u: User) => User): Array<() => Promise<unknown>> =>
  Array.from({ length: count }, () => {
    const person = via(world.users.newcomer());
    return () => person.signIn();
  });

scenario("IT-ACC-001 Sign up by GitHub or passkey; no other provider route exists", async (world) => {
  const ann = world.users.newcomer();
  const session = await ann.signIn();
  const account = await ann.as(session).account.show();
  expect(account.identities).toEqual([{ provider: "github", login: expect.any(String) }]);

  const visitor = world.visitor();
  const unknown = await visitor.get("/no/such/path");
  for (const provider of ["google", "apple", "email"]) await expect(visitor.signInWith(provider)).toLookTheSameAs(unknown);

  const outbound = await world.recorder.invocations({ raw: true });
  expect(outbound.filter((i) => /google|apple/.test(i.target))).toEqual([]);
  expect(await world.github.writes()).toEqual([]);

  const bea = world.users.newcomer({ via: "passkey" });
  const beas = await bea.signIn({ via: "passkey" });
  expect(beas.landedOn).toContain("step=handle");
  await expect(bea.as(beas).account.show()).resolves.toMatchObject({ identities: [] });
  expect(bea.mfa.codes()).toHaveLength(10);
  await bea.as(beas).signOut();
  const again = await bea.signIn({ via: "passkey" });
  await expect(bea.as(again).account.show()).resolves.toMatchObject({ id: expect.any(String) });
  const hosts = (await world.recorder.invocations({ raw: true })).filter((i) => /google|apple/.test(i.target));
  expect(hosts).toEqual([]);
});

scenario("IT-ACC-002 First login must pick a unique, non-reserved, non-confusable handle", async (world) => {
  await world.users.create({ handle: "taken" });
  const person = world.users.newcomer();
  const session = await person.signIn();
  expect(session.landedOn).toContain("step=handle");

  await expect(person.chooseHandle(world.alias("taken"))).toBeRefusedSaying("taken");
  for (const word of [...RESERVED, "probe", "packserver-canary"]) await expect(person.chooseHandle(word)).toBeRefusedSaying("reserved");
  await expect(person.account.show()).resolves.toMatchObject({ handle: null });

  await person.chooseHandle(world.alias("fresh"));
  await expect(person.account.show()).resolves.toMatchObject({ handle: world.alias("fresh") });
});

scenario("IT-ACC-004 A provider sign-in never merges into another account", async (world) => {
  const ann = await world.users.create({ email: `${world.alias("ann")}@example.test` });
  await ann.signIn();
  const impostor = world.users.newcomer({ email: ann.email });

  await expect(impostor.signIn()).toBeRefusedSaying("original method");

  const sessions = await ann.sessions.list();
  expect(sessions).toHaveLength(1);
  const account = await ann.account.show();
  expect(account.identities).toHaveLength(1);
});

scenario("IT-ACC-025 An unverified provider email never links or signs in by email match", async (world) => {
  const ann = await world.users.create({ email: `${world.alias("ann")}@example.test` });
  const mallory = world.users.newcomer({ email: ann.email, emailVerified: false });

  await mallory.signIn();

  await ann.signIn();
  const anns = await ann.account.show();
  const mallorys = await mallory.account.show();
  expect(mallorys.id).not.toBe(anns.id);
  expect(anns.identities).toHaveLength(1);
});

scenario("IT-ACC-023 Return targets are same-origin only", async (world) => {
  const ann = await world.users.create();
  const outside = await ann.signIn({ next: world.users.foreignLink });
  const inside = await ann.signIn({ next: "/packs/@acme/gcp" });
  expect(outside.landedOn).toBe("/");
  expect(inside.landedOn).toBe("/packs/@acme/gcp");
});

scenario("IT-ACC-019 Auth forms carry a human check, rate limits and a per-address email cap", async (world) => {
  const bot = world.users.newcomer().failingHumanCheck();
  await expect(bot.signIn()).toRequireHumanCheck();
  await expect(bot.account.show()).toBeRefused("signed-out");

  const oneIp = outcomes(signUps(world, 24, (u) => u.from("192.0.2.77")));
  expectRefusedAfterSome(await oneIp);

  const oneAccount = world.users.newcomer();
  const fromMany = outcomes(Array.from({ length: 24 }, (_, i) => () => oneAccount.from(`192.0.2.${100 + i}`).signIn()));
  expectRefusedAfterSome(await fromMany);

  await expect(world.users.newcomer().from("192.0.2.250").signIn()).resolves.toMatchObject({ id: expect.any(String) });
});

scenario("IT-ACC-013 Sessions expire after 12 h idle or 7 d absolute; last-seen throttled to 15 min", async (world) => {
  const idle = await world.users.create();
  const active = await world.users.create();
  const steady = await world.users.create();
  const idleSession = await idle.signIn();
  const activeSession = await active.signIn();
  const steadySession = await steady.signIn();

  await world.clock.advance("10m");
  await idle.as(idleSession).account.show();
  await world.clock.advance("10m");
  await active.as(activeSession).account.show();
  await steady.as(steadySession).account.show();
  await world.clock.advance("5h");
  await steady.as(steadySession).account.show();
  await world.clock.advance("6h41m");

  await expect(idle.as(idleSession).account.show()).toBeRefused("signed-out");
  await expect(active.as(activeSession).account.show()).resolves.toMatchObject({ id: expect.any(String) });
  await expect(steady.as(steadySession).account.show()).resolves.toMatchObject({ id: expect.any(String) });

  for (let i = 0; i < 24; i++) {
    await world.clock.advance("6h");
    await steady.as(steadySession).account.show();
  }
  await world.clock.advance("11h");
  await steady.as(steadySession).account.show();
  await world.clock.advance("1h");
  await expect(steady.as(steadySession).account.show()).toBeRefused("signed-out");
});

scenario("IT-ACC-021 Sessions rotate on sign-in and step-up; cookie attributes are hardened", async (world) => {
  const ann = await world.users.create();
  const first = await ann.signIn();
  const second = await ann.signIn();
  expect(second.id).not.toBe(first.id);
  await expect(ann.as(first).account.show()).toBeRefused("signed-out");
  expect(second.cookie).toEqual({ name: expect.any(String), secure: true, httpOnly: true, sameSite: "Lax", path: "/", domain: undefined });

  const keyed = await world.users.create({ mfa: "passkey" });
  const before = await keyed.signIn();
  const asserted = await keyed.assertionFor({ action: "token.mint", target: "a" });
  expect(asserted.session.id).not.toBe(before.id);
  await expect(keyed.as(before).account.show()).toBeRefused("signed-out");
  await expect(keyed.as(asserted.session).account.show()).resolves.toMatchObject({ id: expect.any(String) });
  const enrolled = await keyed.mfa.enrol();
  expect(enrolled.id.length).toBeGreaterThan(0);
  await expect(keyed.as(asserted.session).account.show()).toBeRefused("signed-out");
  expect((await keyed.account.show()).id.length).toBeGreaterThan(0);

  await ann.as(second).signOut();
  await expect(ann.as(second).account.show()).toBeRefused("signed-out");
});

scenario("IT-ABUSE-002 Public forms require a passed human check", async (world) => {
  const bot = world.users.newcomer().failingHumanCheck();
  await expect(bot.signIn()).toRequireHumanCheck();
  const human = world.users.newcomer();
  await expect(human.signIn()).resolves.toMatchObject({ id: expect.any(String) });
});

scenario("IT-ABUSE-005 Auth endpoints are rate-limited per IP and account", async (world) => {
  expectRefusedAfterSome(await outcomes(signUps(world, 24, (u) => u.from("198.18.0.50"))));

  const target = world.users.newcomer();
  expectRefusedAfterSome(await outcomes(Array.from({ length: 24 }, (_, i) => () => target.from(`198.18.1.${i + 1}`).signIn())));

  await expect(world.users.newcomer().from("198.18.2.1").signIn()).resolves.toMatchObject({ id: expect.any(String) });
});

scenario("IT-ABUSE-007 Forms carry CSRF tokens and idempotency keys", async (world) => {
  const ann = world.users.newcomer();
  const bob = world.users.newcomer();
  await ann.signIn();
  const bobs = await bob.signIn();
  const handle = world.alias("ann");

  await expect(ann.chooseHandle(handle, { csrf: "none" })).toBeRefused("forbidden");
  await expect(ann.chooseHandle(handle, { csrf: bobs })).toBeRefused("forbidden");
  await expect(ann.chooseHandle(handle, { origin: "foreign" })).toBeRefused("forbidden");
  await expect(ann.account.show()).resolves.toMatchObject({ handle: null });

  await ann.chooseHandle(handle, { idempotencyKey: "replayed-key-0001" });
  await ann.chooseHandle(handle, { idempotencyKey: "replayed-key-0001" });
  await expect(ann.account.show()).resolves.toMatchObject({ handle });
  await expect(ann.chooseHandle(world.alias("another"))).toBeRefusedSaying("already has a handle");
  await expect(ann.account.show()).resolves.toMatchObject({ handle });
});

scenario("IT-ACC-005 A first passkey enrols freely; every further factor is a sensitive action with a 24-hour hold on publishing", async (world) => {
  const u = world.users.newcomer();
  await u.signIn();
  const first = await u.mfa.enrol();
  expect(first.recoveryCodes).toHaveLength(10);
  await expect(u.mfa.enrol({ assertion: "none" })).toBeRefused("step-up");
  await expect(u.mfa.passkeys()).resolves.toHaveLength(1);
  await expect(u.mfa.regenerateCodes({ assertion: "none" })).toBeRefused("step-up");
  const second = await u.mfa.enrol();
  expect(second.recoveryCodes).toEqual([]);
  await expect(u.mfa.passkeys()).resolves.toHaveLength(2);
  expect(await u.mfa.regenerateCodes()).toHaveLength(10);

  const early = await world.users.create({ seedScope: "early" });
  await early.signIn();
  const noticed = () => world.mail.inbox(early).all().filter((m) => /factor/i.test(m.subject)).length;
  expect(noticed()).toBe(0);
  const lone = await early.mfa.enrol();
  expect(noticed()).toBe(1);
  expect((await early.mfa.passkeys()).find((k) => k.id === lone.id)!.heldUntil).toBeNull();

  const addresses = [`${world.alias("p")}-two@example.test`];
  const p = await world.users.create({ mfa: "passkey", seedScope: "pscope", moreEmails: addresses });
  await p.signIn();
  const id = (await p.account.show()).id;
  const bySession = await p.assertionFor({ action: "factor.add", target: id }, { recoveryCode: p.mfa.codes()[0]! });
  const k2 = await p.mfa.enrol({ assertion: bySession });
  const held = (await p.mfa.passkeys()).find((k) => k.id === k2.id)!;
  expect(held.heldUntil).not.toBeNull();
  for (const address of [p.email, addresses[0]!]) {
    expect(world.mail.inbox({ email: address }).all().some((m) => /passkey|factor/i.test(m.subject))).toBe(true);
  }

  await world.clock.advance("1h");
  await expect(p.assertionFor({ action: "publish.approve", target: "v1" }, { passkey: k2 })).toBeRefused("step-up");
  await expect(p.assertionFor({ action: "publish.approve", target: "v1" })).resolves.toMatchObject({ method: "passkey" });
  const notices = () => world.mail.inbox(p).all().filter((m) => /factor/i.test(m.subject)).length;
  const before = notices();
  const underHeld = await p.assertionFor({ action: "recovery.regenerate", target: id }, { passkey: k2 });
  const laundered = await p.mfa.regenerateCodes({ assertion: underHeld });
  expect(notices()).toBe(before + 1);
  await expect(p.assertionFor({ action: "publish.approve", target: "v1" }, { recoveryCode: laundered[0]! })).toBeRefused("step-up");
  await world.clock.advance("23h1m");
  await p.signIn();
  await expect(p.assertionFor({ action: "publish.approve", target: "v2" }, { passkey: k2 })).resolves.toMatchObject({ method: "passkey" });
  await expect(p.assertionFor({ action: "publish.approve", target: "v2" }, { recoveryCode: laundered[1]! })).resolves.toMatchObject({ method: "recovery" });

  const k3 = await p.mfa.enrol();
  expect((await p.mfa.passkeys()).find((k) => k.id === k3.id)!.heldUntil).toBeNull();
  await expect(p.assertionFor({ action: "publish.approve", target: "v3" }, { passkey: k3 })).resolves.toMatchObject({ method: "passkey" });

  const pages = await p.mfa.pages();
  expect(pages).toContain('"offered":["passkey"]');
  expect(pages).not.toMatch(/totp/i);
});

scenario("IT-ACC-006 Ten recovery codes shown once, with a reminder until saved", async (world) => {
  const person = world.users.newcomer();
  await person.signIn();
  const { recoveryCodes } = await person.mfa.enrol();
  expect(new Set(recoveryCodes).size).toBe(10);

  await expect(person.mfa.recovery()).resolves.toEqual({ hasCodes: true, saved: false, remaining: 10 });
  await person.mfa.confirmCodesSaved();
  await expect(person.mfa.recovery()).resolves.toEqual({ hasCodes: true, saved: true, remaining: 10 });
  const pages = await person.mfa.pages();
  for (const code of recoveryCodes) expect(pages).not.toContain(code);
});

scenario("IT-ACC-007 A recovery code is single-use", async (world) => {
  const person = await world.users.create({ mfa: "passkey" });
  await person.signIn();
  const codes = person.mfa.codes();
  expect(codes).toHaveLength(10);

  const first = await person.assertionFor({ action: "token.mint", target: "a" }, { recoveryCode: codes[0]! });
  expect(first.notice).toEqual({ warning: "recovery-code-used", remaining: 9, offer: "regenerate" });
  await expect(person.assertionFor({ action: "token.mint", target: "a" }, { recoveryCode: codes[0]! })).toBeRefused("step-up");
  await expect(person.assertionFor({ action: "token.mint", target: "a" }, { recoveryCode: codes[1]! })).resolves.toMatchObject({ method: "recovery" });

  await person.mfa.regenerateCodes();
  await expect(person.assertionFor({ action: "token.mint", target: "a" }, { recoveryCode: codes[2]! })).toBeRefused("step-up");
  await expect(person.assertionFor({ action: "token.mint", target: "a" }, { recoveryCode: person.mfa.codes()[0]! })).resolves.toMatchObject({ method: "recovery" });
});

scenario("IT-ACC-010 Sensitive actions take a passkey assertion bound to the action; there is no window", async (world) => {
  const p = await world.users.create({ mfa: "passkey" });
  await p.signIn();
  const id = (await p.account.show()).id;
  const before = p.mfa.codes();

  await expect(p.mfa.regenerateCodes({ assertion: "none" })).toBeRefused("step-up");
  expect(await p.mfa.recovery()).toMatchObject({ remaining: 10 });
  const wrongAction = await p.assertionFor({ action: "yank", target: id });
  await expect(p.mfa.regenerateCodes({ assertion: wrongAction })).toBeRefused("step-up");
  const regenerated = await p.mfa.regenerateCodes();
  expect(regenerated).not.toEqual(before);

  await world.clock.advance("6h");
  await expect(p.mfa.regenerateCodes({ assertion: "none" })).toBeRefused("step-up");
  await expect(p.mfa.regenerateCodes({ assertion: "replay" })).toBeRefused("step-up");
});

scenario("IT-ACC-011 Five failed assertions lock step-up for 15 minutes with an email", async (world) => {
  const p = await world.users.create({ mfa: "passkey" });
  await p.signIn();
  const alerts = () => world.mail.inbox(p).all().filter((m) => /locked|too many/i.test(m.subject)).length;

  for (let i = 0; i < 5; i++) await p.failAssertion({ action: "token.mint", target: "a" });
  await expect(p.assertionFor({ action: "token.mint", target: "a" })).toBeRefused("rate-limited");
  expect(alerts()).toBe(1);
  await expect(p.account.show()).resolves.toMatchObject({ id: expect.any(String) });

  await world.clock.advance("14m");
  await expect(p.assertionFor({ action: "token.mint", target: "a" })).toBeRefused("rate-limited");
  await world.clock.advance("1m1s");
  await expect(p.assertionFor({ action: "token.mint", target: "a" })).resolves.toMatchObject({ method: "passkey" });
  expect(alerts()).toBe(1);
});

scenario("IT-ACC-017 Removing a factor needs a fresh assertion", async (world) => {
  const p = await world.users.create({ mfa: "passkey" });
  await p.signIn();
  const second = await p.mfa.enrol();
  await expect(p.mfa.remove(second, { assertion: "none" })).toBeRefused("step-up");
  await expect(p.mfa.passkeys()).resolves.toHaveLength(2);

  await p.mfa.remove(second);
  await expect(p.mfa.passkeys()).resolves.toHaveLength(1);
});

scenario("IT-ACC-022 An assertion is bound to its session and target and cannot be replayed", async (world) => {
  const p = await world.users.create({ mfa: "passkey" });
  const laptop = p.as(await p.signIn());
  await p.as({ id: "no-cookie" }).signIn();
  const id = (await p.account.show()).id;
  const regenerate = { action: "recovery.regenerate", target: id };

  const forOther = await p.assertionFor({ action: "recovery.regenerate", target: "someone-else" });
  await expect(p.mfa.regenerateCodes({ assertion: forOther })).toBeRefused("step-up");
  expect(await p.mfa.recovery()).toMatchObject({ remaining: 10 });

  const madeOnPhone = await p.assertionFor(regenerate);
  await expect(laptop.mfa.regenerateCodes({ assertion: madeOnPhone })).toBeRefused("step-up");
  const codes = await p.mfa.regenerateCodes({ assertion: madeOnPhone });
  expect(codes).toHaveLength(10);
  await expect(p.mfa.regenerateCodes({ assertion: "replay" })).toBeRefused("step-up");

  const byCode = await p.assertionFor(regenerate, { recoveryCode: codes[0]! });
  await p.mfa.regenerateCodes({ assertion: byCode });
  await expect(p.assertionFor(regenerate, { recoveryCode: codes[0]! })).toBeRefused("step-up");

  for (let i = 0; i < 5; i++) await p.failAssertion(regenerate, { recoveryCode: "not-a-code" });
  await expect(p.assertionFor(regenerate, { recoveryCode: p.mfa.codes()[1]! })).toBeRefused("rate-limited");
});
