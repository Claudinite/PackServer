import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts, World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage", "reset"] };
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

scenario("IT-ADMIN-008 The admin Worker validates the Access assertion itself", async (world) => {
  const refused = ["forged", "wrong-audience", "expired", "outsider", "missing", "workers-dev", "preview-url"] as const;
  for (const how of refused) expect(await world.admins.visit(how), how).toEqual({ found: false });
  expect(await world.admins.visit("valid")).toEqual({ found: true });
}, NEEDS);

scenario("IT-ADMIN-003 Admins approve or reject held versions with the diff and findings (decision half)", async (world) => {
  const admin = await world.admins.create();
  const rev = await world.publishers.create({ handle: "rev" });
  const first = await clean(world, rev, "rev", "1.0.0");
  await world.admins.promoted(first);

  const approved = await held(world, rev, "rev", "1.1.0", { "env/setup.sh": ENV_SETUP });
  const item = await admin.queue.open(approved);
  expect(item.against).toBe("1.0.0");
  expect(item.files.find((f) => f.path === "README.md")).toMatchObject({ change: "modified" });
  expect(item.files.find((f) => f.path === "env/setup.sh")).toMatchObject({ change: "added" });
  expect(item.capabilities).toMatchObject({ added: ["env-setup"], removed: [] });
  expect(item.findings.find((f) => f.rule === "text.url-install")).toMatchObject({ class: "hold", file: "README.md" });
  expect(item.findings.find((f) => f.rule === "text.url-install")?.quote).toContain("pip install");

  await admin.queue.approve(approved);
  expect(await admin.queue.decision(approved)).toMatchObject({ decision: "approve", decidedBy: admin.email });
  expect((await admin.queue.list()).filter((e) => e.kind === "held-version")).toEqual([]);

  const rejected = await held(world, rev, "rev", "1.2.0");
  await admin.queue.reject(rejected, "The helper archive is not one we can let your pack run");
  expect(await admin.queue.decision(rejected)).toMatchObject({ decision: "reject", reason: "The helper archive is not one we can let your pack run" });
  expect(world.mail.inbox(rev).latest().text).toContain("The helper archive is not one we can let your pack run");

  const other = await world.publishers.create({ handle: "oth" });
  const flagged = await held(world, other, "oth", "1.0.0");
  await admin.queue.quarantinePublisher(flagged, "Install from a URL, again");
  expect(await admin.queue.decision(flagged)).toMatchObject({ decision: "quarantine_publisher" });
  await expect(other.publish(world.archive("gcp")).as("@oth/tool@1.0.1")).toBeRefused();
}, NEEDS);
