import { accepted, expect, scenario, type ScenarioOpts } from "@packserver/test-world";

const storage: ScenarioOpts = { needs: ["storage"] };

const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_ON_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const WORKFLOW = ".github/workflows/publish.yml";

scenario("IT-ACC-012 Sessions are listable and revocable; sensitive actions stop at once", async (world) => {
  const p = await world.users.create({ mfa: "passkey" });
  const laptop = await p.signIn();
  const phone = await p.onDevice({ userAgent: PHONE, country: "SE" }).as({ id: "no-cookie" }).signIn();

  const listed = await p.as(laptop).sessions.list();
  expect(listed.map((s) => s.device.label).sort()).toEqual(["Firefox on Linux", "Safari on iOS"]);
  expect(listed.map((s) => s.lastSeen.getTime()).every((t) => t > 0)).toBe(true);
  const onPhone = listed.find((s) => !s.current)!;
  await expect(p.as(phone).account.show()).resolves.toMatchObject({ id: expect.any(String) });

  await p.as(laptop).sessions.revoke(onPhone);
  await expect(p.as(phone).tokens.mint({ readScope: p.handle })).toBeRefused("signed-out");
  await expect(p.as(phone).account.show()).toBeRefused("signed-out");
  await world.clock.advance("60s");
  await expect(p.as(phone).account.show()).toBeRefused("signed-out");

  await expect(p.as(laptop).account.show()).resolves.toMatchObject({ id: expect.any(String) });
  expect(await p.as(laptop).sessions.list()).toHaveLength(1);
  const another = await p.as(laptop).sessions.list();
  await expect(p.as(laptop).sessions.revoke({ id: `${another[0]!.id}x` })).toBeRefusedSaying("No such session");
});

scenario("IT-ACC-014 New-device sign-in sends an email notice", async (world) => {
  const p = await world.users.create();
  const notices = () => world.mail.inbox(p).all().filter((m) => /new sign-in/i.test(m.subject));

  await p.signIn();
  await p.signIn();
  expect(notices()).toHaveLength(0);

  const elsewhere = p.onDevice({ userAgent: CHROME_ON_MAC, country: "SE" });
  await elsewhere.as({ id: "no-cookie" }).signIn();
  expect(notices()).toHaveLength(1);
  expect(notices()[0]!.text).toContain("Chrome on macOS");
  expect(notices()[0]!.text).toContain("SE");

  await elsewhere.as({ id: "no-cookie" }).signIn();
  await p.signIn();
  expect(notices()).toHaveLength(1);
});

scenario("IT-ACC-015 GitHub sign-in is the recovery path; recovery with nothing left waits 72 h under review and blocks publishing", async (world) => {
  const g = await world.users.create({ mfa: "passkey" });
  await g.signIn();
  await g.loseFactors({ passkeys: true });
  await g.signOut();
  const back = await g.signIn();
  expect(back.landedOn).toBe("/");
  const fresh = await g.mfa.enrol();
  expect(fresh.recoveryCodes).toHaveLength(10);
  expect((await g.mfa.passkeys()).find((k) => k.id === fresh.id)!.heldUntil).toBeNull();

  const second = `${world.alias("p")}-two@example.test`;
  const p = await world.users.create({ moreEmails: [second], seedScope: "acme" });
  const repo = world.ci.repo("acme/packs", { id: 5150, ownerId: 1001 });
  await world.ci.seedTrustedPublisher({ pack: "@acme/gcp", repo, workflow: WORKFLOW, environment: "release", path: "packs/gcp" });
  const publish = (version: string) => world.ci.workflow({ repo, environment: "release", ref: "refs/tags/gcp/1.0.0", job: "publish" }).exchange("@acme/gcp", version);
  accepted(await publish("1.0.0"));

  await p.signIn();
  await p.loseFactors({ providers: true });
  await p.signOut();
  await expect(p.signIn()).toBeRefusedSaying("original method");

  const notices = (address: string) => world.mail.inbox({ email: address }).all().filter((m) => /recovery requested/i.test(m.subject));
  await p.recovery.request();
  for (const address of [p.email, second]) expect(notices(address)).toHaveLength(1);
  await p.recovery.request();
  await p.recovery.request("nobody-at-all@example.test");
  expect(notices(p.email)).toHaveLength(1);
  await expect(publish("1.0.1")).toBeRefused("forbidden");

  await world.clock.advance("71h");
  await expect(world.recoveries.approve(p)).toBeRefusedSaying("too_early");
  await expect(publish("1.0.1")).toBeRefused("forbidden");
  await world.clock.advance("1h");
  await world.recoveries.approve(p);
  await expect(publish("1.0.1")).toBeRefused("forbidden");

  await p.recovery.request(second);
  const session = await p.recovery.signIn(second);
  expect(session.landedOn).toContain("enrol");
  await expect(p.recovery.signIn(second)).toBeRefused("forbidden");
  const first = await p.mfa.enrol();
  expect((await p.mfa.passkeys()).find((k) => k.id === first.id)!.heldUntil).toBeNull();
  accepted(await publish("1.0.1"));
}, storage);

scenario("IT-ACC-016 Account deletion needs an assertion; the handle is never reassigned", async (world) => {
  const p = await world.publishers.create({ mfa: "passkey" });
  const org = await p.orgs.create("acme");
  await expect(p.account.delete({ assertion: "none" })).toBeRefused("step-up");
  await expect(p.account.show()).resolves.toMatchObject({ handle: world.alias(p.handle) });

  await expect(p.account.delete()).toBeRefusedSaying("only owner");
  await org.delete();

  await p.account.delete();
  await expect(p.account.show()).toBeRefused("signed-out");

  const next = world.users.newcomer();
  await next.signIn();
  await expect(next.chooseHandle(world.alias(p.handle))).toBeRefusedSaying("taken");
  await expect(next.chooseHandle(world.alias("acme"))).toBeRefusedSaying("taken");
});

scenario("IT-ACC-018 A scope can require MFA or passkeys only for everyone acting for it", async (world) => {
  const owner = await world.publishers.create({ handle: "owner", mfa: "passkey" });
  const m = await world.publishers.create({ handle: "m" });
  const k = await world.publishers.create({ handle: "k", mfa: "passkey" });
  const org = await owner.orgs.create("acme");
  for (const person of [m, k]) {
    await org.invite(person).as("maintainer");
    const [offered] = await world.invitations.pending(person);
    await world.invitations.accept(person, { id: offered!.id });
  }
  const personal = (who: typeof m) => world.orgs.get(who.scope.name, who).people();
  const acting = (who: typeof m) => org.as(who).people();

  await expect(acting(m)).resolves.toMatchObject({ you: "maintainer" });
  await expect(org.as(k).requireMfa("none")).toBeRefused("forbidden");
  await expect(org.requireMfa("mfa", { assertion: "none" })).toBeRefused("step-up");
  await expect(acting(m)).resolves.toMatchObject({ you: "maintainer" });

  await org.requireMfa("mfa");
  await expect(acting(m)).toBeRefused("mfa-required");
  await expect(acting(k)).resolves.toMatchObject({ you: "maintainer" });
  await org.requireMfa("passkey");
  await expect(acting(m)).toBeRefused("mfa-required");
  await expect(acting(k)).resolves.toMatchObject({ you: "maintainer" });
  await expect(personal(m)).resolves.toMatchObject({ you: "owner" });
  await expect(personal(k)).resolves.toMatchObject({ you: "owner" });

  await m.mfa.enrol();
  await expect(acting(m)).resolves.toMatchObject({ you: "maintainer" });
  await expect(acting(k)).resolves.toMatchObject({ you: "maintainer" });
  await expect(personal(m)).resolves.toMatchObject({ you: "owner" });

  await org.requireMfa("none");
  await expect(acting(k)).resolves.toMatchObject({ you: "maintainer" });
});

scenario("IT-ACC-020 Providers link only explicitly, as a sensitive action", async (world) => {
  const a = await world.users.create({ via: "passkey" });
  await a.signIn({ via: "passkey" });
  await expect(a.account.show()).resolves.toMatchObject({ identities: [] });

  await expect(a.providers.linkGitHub({ assertion: "none" })).toBeRefused("step-up");
  await expect(a.account.show()).resolves.toMatchObject({ identities: [] });
  await a.providers.linkGitHub();
  const linked = await a.account.show();
  expect(linked.identities).toEqual([{ provider: "github", login: expect.any(String) }]);
  expect((await a.account.history()).map((e) => e.action)).toContain("provider.linked");

  await a.signIn();
  await expect(a.account.show()).resolves.toMatchObject({ id: linked.id });
  await a.signIn({ via: "passkey" });
  await expect(a.account.show()).resolves.toMatchObject({ id: linked.id });

  const b = await world.users.create();
  await b.signIn();
  const bs = await b.account.show();
  await expect(world.users.newcomer({ email: b.email }).signIn()).toBeRefusedSaying("original method");
  const strangers = world.users.newcomer({ via: "passkey", email: b.email });
  await strangers.signIn({ via: "passkey" });
  expect((await strangers.account.show()).id).not.toBe(bs.id);
  await expect(b.account.show()).resolves.toMatchObject({ identities: bs.identities });
});

scenario("IT-AUDIT-002 People see their own security history for 90 days", async (world) => {
  const owner = await world.users.create({ handle: "ann", mfa: "passkey" });
  await owner.signIn();
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  await world.tokens.seedOwner(owner, secret);
  await owner.mfa.enrol();
  await owner.tokens.mint({ read: secret });

  const wanted = ["login", "factor.added", "token.minted"];
  const actions = async () => (await owner.account.history()).map((e) => e.action);

  await world.clock.advance("89d");
  await owner.signIn();
  expect(await actions()).toEqual(expect.arrayContaining(wanted));
  await world.clock.advance("2d");
  await owner.signIn();
  expect(await actions()).toEqual(expect.arrayContaining(wanted));
}, storage);
