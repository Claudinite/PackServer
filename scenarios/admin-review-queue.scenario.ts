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
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
async function clean(world: World, publisher: Person, handle: string, version: string) {
  const admitted = await publisher.publish(world.archive("gcp")).as(`@${handle}/tool@${version}`);
  expect(["pass", "warn"]).toContain(await (await world.validation.completes(admitted)).verdict());
  return admitted;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
const without = <T extends object>(profile: T, ...keys: string[]) => Object.fromEntries(Object.entries(profile).filter(([k]) => !keys.includes(k)));

scenario("IT-VAL-013 Held versions queue by standing and never resolve by timeout (queue half)", async (world) => {
  const admin = await world.admins.create();
  const [fresh, modest, popular, vp] = await Promise.all(["fresh", "modest", "popular", "vp"].map((handle) => world.publishers.create({ handle })));
  const oldest = await held(world, fresh!, "fresh", "1.0.0");
  const [fewRepos, manyRepos] = await Promise.all([
    held(world, modest!, "modest", "1.0.0"),
    held(world, popular!, "popular", "1.0.0"),
    held(world, vp!, "vp", "1.0.0"),
  ]);
  await world.admins.proveDomain(vp!.scope, "vp.example");
  await admin.applications.grant(vp!.scope);
  await world.admins.declaredBy(manyRepos.pack, 500);
  await world.admins.declaredBy(fewRepos.pack, 5);

  const order = async () => (await admin.queue.list()).filter((e) => e.kind === "held-version").map((e) => e.pack);
  const expected = ["@vp/tool", "@popular/tool", "@modest/tool", "@fresh/tool"];
  expect(await order()).toEqual(expected);
  expect((await admin.queue.list())[0]).toMatchObject({ standing: { verified: true } });

  await world.clock.advance("30d");
  expect(await order()).toEqual(expected);

  await oldest.abandonInstance();
  await admin.queue.approve(oldest);
  expect(await admin.queue.decision(oldest)).toMatchObject({ decision: "approve" });
  expect(await order()).toEqual(expected.slice(0, 3));
  expect(await oldest.resume()).toMatchObject([{ source: "review", delivered: "instance" }]);
  await oldest.promoted();
}, NEEDS);

scenario("IT-VAL-040 A rejected version can be appealed once; the appeal never reaches a model (admin half)", async (world) => {
  const admin = await world.admins.create();
  const publisher = await world.publishers.create({ handle: "app" });
  const denied = await held(world, publisher, "app", "1.0.0");
  const upheld = await held(world, publisher, "app", "1.0.1");
  for (const version of [denied, upheld]) await admin.queue.reject(version, "Not acceptable as written");
  await expect(denied.appeal("x".repeat(2001), publisher)).toBeRefused();
  await denied.appeal("The helper is a build tool, here is the repository", publisher);
  await upheld.appeal("The URL is documentation, not an install step", publisher);
  await expect(denied.appeal("Once more, please", publisher)).toBeRefused();

  const item = await admin.queue.open(denied);
  expect(item.appeal).toEqual({ note: "The helper is a build tool, here is the repository", state: "open" });
  expect(item.findings.map((f) => f.rule)).toContain("text.url-install");
  expect((await admin.appeals.list()).map((a) => a.version).sort()).toEqual(["1.0.0", "1.0.1"]);

  await admin.appeals.deny(denied);
  await admin.appeals.uphold(upheld);
  expect((await admin.queue.open(denied)).appeal?.state).toBe("denied");
  expect((await admin.queue.open(upheld)).appeal?.state).toBe("upheld");
  await expect(admin.appeals.uphold(denied)).toBeRefusedSaying("already decided");
  await expect(admin.appeals.deny(upheld)).toBeRefusedSaying("already decided");
  expect(await admin.appeals.list()).toEqual([]);
  const before = await world.sandbox.calls();
  await upheld.resume();
  await upheld.promoted();
  expect(await world.sandbox.calls()).toEqual(before);
  expect(await denied.downloadable()).toBe(false);
}, NEEDS);
