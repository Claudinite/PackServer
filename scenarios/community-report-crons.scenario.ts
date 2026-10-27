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
  await world.reports.upload(reporter, pack, { name: "shot.png", bytes: 256 });
  expect(await world.reports.pendingUploads()).toBe(1);
  const security = { email: world.reports.securityAddress };

  const ended = `Security report disclosure timer ended on ${pack.systemName}`;
  const endedMails = () => world.mail.inbox(security).all().filter((m) => m.subject === ended);

  await world.clock.advance("82d");
  await world.cron.run("report-notices");
  expect(world.mail.inbox(owner).all()).toEqual([]);
  expect(await world.reports.pendingUploads()).toBe(0);

  await world.clock.advance("1d");
  await world.cron.run("report-notices");
  expect(endedMails()).toEqual([]);
  expect(world.mail.inbox(owner).all().map((m) => m.subject)).toEqual([`A security report on ${pack.systemName} is disclosed in 7 days`]);

  await world.clock.advance("7d");
  await world.cron.run("report-notices");
  expect(endedMails()).toHaveLength(1);
  expect(await world.reports.queued("registry-security", pack)).toEqual([]);

  await world.cron.run("report-notices");
  expect(endedMails()).toHaveLength(1);
  expect(world.mail.inbox(owner).all()).toHaveLength(1);
}, NEEDS);
