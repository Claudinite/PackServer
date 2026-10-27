import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts, World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage", "reset"] };

type Person = Awaited<ReturnType<World["publishers"]["create"]>>;

/** Publishes `version` of `@<handle>/tool` with the gcp pack plus `files`. */
async function publish(world: World, by: Person, handle: string, version: string, files: Record<string, string> = {}) {
  const admitted = await by.publish(world.archive("gcp", { files })).as(`@${handle}/tool@${version}`);
  await world.validation.completes(admitted);
  return admitted;
}

scenario("IT-PUB-019 Staged publishing holds a validated version until approval; the declared threshold is 100 once the scan has run", async (world) => {
  const admin = await world.admins.create();
  const [vp, popular, edge, plain] = await Promise.all(["vp", "popular", "edge", "plain"].map((handle) => world.publishers.create({ handle })));
  await world.admins.proveDomain(vp!.scope, "vp.example");
  await admin.applications.grant(vp!.scope);

  const first = await Promise.all([publish(world, vp!, "vp", "1.0.0"), publish(world, popular!, "popular", "1.0.0"), publish(world, edge!, "edge", "1.0.0"), publish(world, plain!, "plain", "1.0.0")]);
  const [staged, ...others] = first;
  expect(await staged!.approval()).toMatchObject({ state: "awaiting", reasons: ["verified-publisher"] });
  expect(await staged!.downloadable()).toBe(false);
  for (const version of others) expect(await version.approval()).toBeNull();
  await Promise.all(others.map((version) => version.promoted()));

  await world.admins.declaredBy(others[0]!.pack, 101);
  await world.admins.declaredBy(others[1]!.pack, 100);
  const second = await Promise.all([publish(world, popular!, "popular", "1.0.1"), publish(world, edge!, "edge", "1.0.1"), publish(world, plain!, "plain", "1.0.1")]);
  expect(await second[0]!.approval()).toMatchObject({ state: "awaiting", reasons: ["declared-threshold"] });
  expect(await second[0]!.downloadable()).toBe(false);
  expect(await second[1]!.approval()).toBeNull();
  expect(await second[2]!.approval()).toBeNull();
  await Promise.all([second[1]!.promoted(), second[2]!.promoted()]);

  await staged!.approve({ by: vp! });
  await staged!.promoted();
  expect(await staged!.downloadable()).toBe(true);
}, NEEDS);

scenario("IT-VAL-052 A widening of executable capability waits for the publisher's own passkey", async (world) => {
  const admin = await world.admins.create();
  const p = await world.publishers.create({ handle: "p" });
  const m = await world.publishers.create({ handle: "m" });
  const org = await p.orgs.create("acme");
  await org.invite(m).as("maintainer");
  await world.invitations.accept(m, (await world.invitations.pending(m))[0]!);
  const note = (text: string) => ({ "RULES.md": `# Rules\n\n${text}\n` });
  const release = async (by: Person, version: string, files: Record<string, string>) => {
    const admitted = await by.publish(world.archive("gcp", { files })).as(`@acme/tool@${version}`);
    await world.validation.completes(admitted);
    return admitted;
  };

  await (await release(p, "1.0.0", note("one"))).promoted();
  const widening = await release(m, "1.1.0", { ...note("one"), "env-setup.sh": "#!/bin/sh\nmkdir -p .cache\n" });
  expect(await widening.approval()).toMatchObject({ state: "awaiting", reasons: ["widening"] });
  expect(await widening.downloadable()).toBe(false);
  expect((await admin.queue.list()).filter((e) => e.pack === "@acme/tool")).toEqual([]);
  const sheet = await widening.approvalSheet(p);
  expect(sheet.sheet.new.length).toBeGreaterThan(0);

  await expect(widening.approve({ by: m })).toBeRefused("forbidden");
  await expect(widening.approve({ by: p, assertion: "none" })).toBeRefused("step-up");
  expect(await widening.downloadable()).toBe(false);
  await widening.approve({ by: p });
  await widening.promoted();
  expect(await widening.downloadable()).toBe(true);

  const prose = await release(p, "1.2.0", { ...note("two"), "env-setup.sh": "#!/bin/sh\nmkdir -p .cache\n" });
  expect(await prose.approval()).toBeNull();
  await prose.promoted();
}, NEEDS);
