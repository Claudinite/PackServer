import { expect, scenario, type ScenarioOpts } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage"] };

scenario("IT-MOD-019 The scheduled report job reminds owners at +83 d and tells registry security at +90 d", async (world) => {
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  const owner = await world.users.create();
  await owner.signIn();
  const reporter = await world.users.create();
  await reporter.signIn();
  await world.reports.seedRole(pack, owner, "owner");
  await world.reports.file(reporter, pack, { kind: "security", title: "Token leaks to logs" });
  const security = { email: world.reports.securityAddress };

  await world.clock.advance("82d");
  await world.cron.run("report-notices");
  expect(world.mail.inbox(owner).all()).toEqual([]);

  await world.clock.advance("1d");
  await world.cron.run("report-notices");
  expect(world.mail.inbox(owner).all().map((m) => m.subject)).toEqual([`A security report on ${pack.systemName} is disclosed in 7 days`]);

  await world.clock.advance("7d");
  await world.cron.run("report-notices");
  const subjects = world.mail.inbox(security).all().map((m) => m.subject);
  expect(subjects.length).toBeGreaterThan(0);
  expect(await world.reports.queued("registry-security", pack)).toEqual([]);
  const delivered = subjects.length;

  await world.cron.run("report-notices");
  expect(world.mail.inbox(security).all()).toHaveLength(delivered);
  expect(world.mail.inbox(owner).all()).toHaveLength(1);
}, NEEDS);
