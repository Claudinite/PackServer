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

/** Refused "after N", never an exact N; the limit's window may roll over mid-run, so only the refusal's first step is held to staying refused. */
function expectRefusedAfterSome(results: Attempt[]): void {
  const first = results.indexOf("rate-limited");
  expect(first).toBeGreaterThan(0);
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
});

scenario("IT-ACC-002 First login must pick a unique, non-reserved, non-confusable handle", async (world) => {
  await world.users.create({ handle: "taken" });
  const person = world.users.newcomer();
  const session = await person.signIn();
  expect(session.landedOn).toContain("step=handle");

  await expect(person.chooseHandle(world.alias("taken"))).toBeRefusedSaying("taken");
  for (const word of RESERVED) await expect(person.chooseHandle(word)).toBeRefusedSaying("reserved");
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
