import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts, World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage", "reset"] };
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
const ENV_SETUP = "#!/bin/sh\nmkdir -p .cache\n";

type Person = Awaited<ReturnType<World["publishers"]["create"]>>;

/** Publishes the next version of `@<handle>/tool` with install-from-URL prose, which the rules hold for review. */
async function held(world: World, publisher: Person, handle: string, version: string, files: Record<string, string> = {}) {
  const readme = `# tool\n\nFirst pip install ${world.link("helper.tar.gz")} and then continue.\n`;
  const admitted = await publisher.publish(world.archive("gcp", { files: { "README.md": readme, ...files } })).as(`@${handle}/tool@${version}`);
  expect(await (await world.validation.completes(admitted)).verdict()).toBe("hold");
  return admitted;
}

/** Publishes the next version of `@<handle>/tool` clean, so it validates without waiting for anyone. */
async function clean(world: World, publisher: Person, handle: string, version: string) {
  const admitted = await publisher.publish(world.archive("gcp")).as(`@${handle}/tool@${version}`);
  expect(["pass", "warn"]).toContain(await (await world.validation.completes(admitted)).verdict());
  return admitted;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
const without = <T extends object>(profile: T, ...keys: string[]) => Object.fromEntries(Object.entries(profile).filter(([k]) => !keys.includes(k)));

scenario("IT-ADMIN-006 Admins see full reports and prose-screen results without numbers", async (world) => {
  const admin = await world.admins.create();
  const publisher = await world.publishers.create({ handle: "rep" });
  const published = await clean(world, publisher, "rep", "2.1.0");
  const waiting = await held(world, publisher, "rep", "2.2.0");

  for (const version of [published, waiting]) {
    const report = await admin.reports.full(version);
    expect(report.proseScreen).toMatchObject({ implementation: "static-only", tripped: [] });
    expect(JSON.stringify(report.proseScreen)).not.toMatch(/threshold|probabilit|\b0\.\d+\b/i);
    expect(report.text).not.toMatch(/probabilit/i);
    expect(await admin.reports.proseScreen(version)).toMatchObject({ implementation: "static-only" });
  }
  const report = await admin.reports.full(waiting);
  expect(report.verdict).toBe("hold");
  expect(report.findings.find((f) => f.rule === "text.url-install")?.quote).toContain("pip install");
}, NEEDS);

scenario("IT-ADMIN-009 Admin reads of private content are audited", async (world) => {
  const admin = await world.admins.create();
  const publisher = await world.publishers.create({ handle: "priv" });
  await world.admins.promoted(await clean(world, publisher, "priv", "1.0.0"));
  const waiting = await held(world, publisher, "priv", "1.1.0");
  await world.admins.makePrivate(waiting);
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  const reporter = await world.users.create();
  await reporter.signIn();
  const filed = await world.reports.file(reporter, pack, { kind: "security", version: "1.0.0", severity: "high", title: "Token leaks to logs" });

  expect(await admin.audit()).toEqual([]);
  await admin.queue.open(waiting);
  await admin.reports.full(waiting);
  await admin.reports.proseScreen(waiting);
  await admin.reports.security(filed);
  const reads = await admin.audit();
  expect(reads.map((r) => r.verb).sort()).toEqual(["read.private-pack", "read.prose-screen", "read.report", "read.validation-report"]);
  for (const read of reads) expect(read).toMatchObject({ action: "admin.action", actor: admin.email });
  expect(reads.map((r) => r.target?.split(":")[1]).sort()).toEqual(["private-pack", "prose-screen", "report", "validation-report"]);

  await world.agents.anonymous().pack(pack);
  await admin.queue.list();
  expect(await admin.audit()).toHaveLength(4);
}, NEEDS);
