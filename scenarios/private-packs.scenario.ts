import { expect, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const storage: ScenarioOpts = { needs: ["storage"] };

const FORBIDDEN_ACTIONS = ["publish", "yank", "mintToken", "setVisibility", "listSessions", "showAccount", "changeEmail", "approveStaged"] as const;
const LAPTOP = "198.51.100.7";

async function laptopLogin(world: World) {
  return world.member().signIn({ from: LAPTOP, country: "SE" });
}

const orgLookups = async (world: World) => (await world.recorder.invocations({ raw: true })).filter((i) => /memberships/.test(i.op ?? ""));

scenario("IT-PRIV-017 cn adopt on a laptop signs in with a device code; the token reads privately and ends with the session", async (world) => {
  const ann = await world.users.create({ handle: "ann" });
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  const member = world.member();

  const first = await laptopLogin(world);
  expect(first.link).not.toContain(first.userCode);
  expect(first.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  expect(await first.poll()).toEqual({ status: "pending" });
  expect(await first.poll()).toEqual({ status: "slow-down" });

  await ann.signIn();
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
