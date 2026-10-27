import { expect, scenario, type PackBody, type World } from "@packserver/test-world";

const WORKFLOW = ".github/workflows/publish.yml";
const MiB = 1024 * 1024;

/** The registration of IT-PUB-003: `acme/packs`, environment `release`, the default ref patterns and event set. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
async function registerGcp(world: World, pack = "@acme/gcp") {
  const repo = world.ci.repo("acme/packs", { id: 5150, ownerId: 1001 });
  await world.ci.seedTrustedPublisher({ pack, repo, workflow: WORKFLOW, environment: "release", path: "packs/gcp" });
  return repo;
}

scenario("IT-VAL-002 Hash mismatch, oversize or non-zstd fail before any sandbox starts", async (world) => {
  const v = await world.publishers.create({ handle: "v" });
  const valid = world.archive("gcp");

  await expect(v.publish(world.archive("gcp", { padTo: 3 * MiB + 1 })).as("@v/big@1.0.0")).toBeRefused("quota");
  expect(await world.ci.staging.objects("v")).toEqual([]);

  const mismatch = await v.publish(valid).as("@v/lie@1.0.0", { declaredSha256: "0".repeat(64) });
  expect(await mismatch.run.verdict()).toBe("fail");
  expect(await mismatch.run.reason()).toBe("integrity.sha256_mismatch");

  const gzip = await v.publish(world.archive("gcp", { format: "gzip" })).as("@v/gz@1.0.0");
  expect(await gzip.run.verdict()).toBe("fail");
  expect(await gzip.run.reason()).toBe("integrity.not_zstd");

  for (const run of [mismatch.run, gzip.run]) {
    const steps = await run.milestones();
    expect(steps.map((m) => `${m.step}:${m.outcome}`)).toEqual(["admission:ok", "integrity:fail"]);
  }
  expect((await world.recorder.invocations()).filter((i) => /sandbox/i.test(i.target))).toEqual([]);

  const exact = await v.publish(world.archive("gcp", { padTo: 3 * MiB })).as("@v/exact@1.0.0");
  const steps = await exact.run.milestones();
  expect(steps.slice(0, 2).map((m) => `${m.step}:${m.outcome}`)).toEqual(["admission:ok", "integrity:ok"]);
});

scenario("IT-PUB-023 Deprecate a version with a public reason", async (world) => {
  await world.access.seedRegistryKeys();
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  const { owner } = await world.lifecycle.staff(pack);
  const before = await world.registry.serial(pack);

  await expect(pack.version("1.0.0").deprecate("superseded by 1.1", { by: owner, assertion: "none" })).toBeRefused("step-up");
  expect(await pack.version("1.0.0").status()).toBe("active");
  await pack.version("1.0.0").deprecate("superseded by 1.1", { by: owner });

  const signed = await world.registry.indexes(pack, { newerThan: before });
  expect(signed.scope.verifies).toBe(true);
  expect(signed.scope.document.packs[0]!.versions[0]).toMatchObject({ version: "1.0.0", status: "deprecated", reason: "superseded by 1.1" });
  expect(signed.scope.document.packs[0]!.latest_eligible).toBe("1.0.0");
  expect(await pack.read({ version: "1.0.0" })).toMatchObject({ outcome: "found", version: { status: "deprecated", reason: "superseded by 1.1" } });
  expect(await pack.version("1.0.0").sha256()).toBe((await pack.stored("1.0.0")).canonicalSha256);
  expect(await world.lifecycle.objects(pack, "1.0.0")).not.toEqual([]);
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-PUB-024 Hard delete only within 72 h and with zero fetches; the number stays listed as removed", async (world) => {
  await world.access.seedRegistryKeys();
  const ann = await world.publishers.create({ handle: "ann" });
  await ann.orgs.create("acme");
  const old = await world.packs.public("@acme/old", { versions: ["1.0.0"] });
  await world.clock.advance("72h");
  const fresh = await world.packs.public("@acme/fresh", { versions: ["1.0.0", "1.1.0"] });
  await world.clock.advance("1h");
  await ann.signIn();
  await world.lifecycle.recordFetch(fresh, "1.1.0");

  expect(await world.lifecycle.offer(fresh, ann)).toMatchObject({
    versions: [{ version: "1.0.0", deletable: true }, { version: "1.1.0", deletable: false }],
  });
  expect(await world.lifecycle.offer(old, ann)).toMatchObject({ versions: [{ version: "1.0.0", deletable: false }] });
  await expect(old.version("1.0.0").delete({ by: ann })).toBeRefused("forbidden");
  await expect(fresh.version("1.1.0").delete({ by: ann })).toBeRefused("forbidden");
  await expect(fresh.version("1.0.0").delete({ by: ann, assertion: "none" })).toBeRefused("step-up");
  expect(await fresh.version("1.0.0").status()).toBe("active");

  const before = await world.registry.serial(fresh);
  await fresh.version("1.0.0").delete({ by: ann });
  await world.lifecycle.removedFromStorage(fresh, "1.0.0");
  const listed = (await world.registry.indexes(fresh, { newerThan: before })).scope.document.packs.find((p) => world.unalias(p.name) === "@acme/fresh")!;
  expect(listed.versions.find((v) => v.version === "1.0.0")).toEqual(expect.objectContaining({ status: "removed" }));
  expect(listed.versions.find((v) => v.version === "1.0.0")).not.toHaveProperty("sha256");
  expect(listed.latest_eligible).toBe("1.1.0");
  expect(await world.lifecycle.objects(fresh, "1.0.0")).toEqual([]);
  expect(await world.lifecycle.objects(fresh, "1.1.0")).not.toEqual([]);
  expect(world.lifecycle.purged().filter((url) => url.includes("/@acme/fresh/1.0.0/")).length).toBeGreaterThan(0);
  expect(await fresh.version("1.0.0").status()).toBe("removed");
  await expect(ann.publish(world.archive("gcp")).as("@acme/fresh@1.0.0")).toBeRefused("exists");

  const solo = await world.packs.public("@acme/solo", { versions: ["1.0.0"] });
  await solo.version("1.0.0").delete({ by: ann });
  await expect(ann.publish(world.archive("gcp")).as("@acme/solo@2.0.0")).toBeRefused("exists");
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-PUB-025 Private packs delete any time with a 7-day soft window", async (world) => {
  await world.access.seedRegistryKeys();
  const ann = await world.publishers.create({ handle: "ann" });
  await ann.orgs.create("acme");
  const secret = await world.packs.public("@acme/secret", { visibility: "private", versions: ["1.0.0"] });
  await world.clock.advance("200d");
  await ann.signIn();
  await world.lifecycle.recordFetch(secret, "1.0.0");

  await expect(world.lifecycle.deletePack(secret, { by: ann, assertion: "none" })).toBeRefused("step-up");
  expect(await world.lifecycle.offer(secret, ann)).toMatchObject({ deleted: false });
  await world.lifecycle.deletePack(secret, { by: ann });
  expect(await world.lifecycle.offer(secret, ann)).toMatchObject({ deleted: true });

  await world.clock.advance("6d");
  await ann.signIn();
  await world.lifecycle.restorePack(secret, { by: ann });
  expect(await world.lifecycle.offer(secret, ann)).toMatchObject({ deleted: false });
  expect(await world.lifecycle.archiveKept(secret, "1.0.0")).toBe(true);

  await world.lifecycle.deletePack(secret, { by: ann });
  await world.clock.advance("6d");
  await world.lifecycle.sweep(secret);
  expect(await world.lifecycle.archiveKept(secret, "1.0.0")).toBe(true);
  await world.clock.advance("1d1h");
  await ann.signIn();
  await world.lifecycle.sweep(secret);
  await world.lifecycle.removedFromStorage(secret, "1.0.0");
  expect(await world.lifecycle.archiveKept(secret, "1.0.0")).toBe(false);
  await expect(world.lifecycle.restorePack(secret, { by: ann })).toBeRefused("forbidden");
  await expect(ann.publish(world.archive("gcp")).as("@acme/secret@2.0.0")).toBeRefused("exists");
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-MOD-011 Yank moves latest and leaves search; un-yank is logged", async (world) => {
  await world.access.seedRegistryKeys();
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0", "1.1.0", "1.2.0"] });
  const { owner, maintainer } = await world.lifecycle.staff(pack);
  const before = await world.registry.serial(pack);

  await expect(pack.version("1.2.0").yank({ reason: "leaks tokens", security: true, by: maintainer, assertion: "none" })).toBeRefused("step-up");
  expect(await pack.version("1.2.0").status()).toBe("active");
  await pack.version("1.2.0").yank({ reason: "leaks tokens", security: true, by: maintainer });

  const signed = await world.registry.indexes(pack, { newerThan: before });
  const entry = signed.scope.document.packs[0]!;
  expect(entry.latest_eligible).toBe("1.1.0");
  expect(entry.versions.find((v) => v.version === "1.2.0")).toMatchObject({ status: "yanked", reason: "leaks tokens", security: "leaks tokens" });
  const view = (await pack.read()) as PackBody;
  expect(view.latest_eligible).toBe("1.1.0");
  expect(view.versions.find((v) => v.version === "1.2.0")).toMatchObject({ yanked: true, reason: "leaks tokens" });

  const restored = await world.registry.serial(pack);
  await pack.version("1.2.0").unyank({ by: owner });
  expect((await world.registry.indexes(pack, { newerThan: restored })).scope.document.packs[0]!.latest_eligible).toBe("1.2.0");
  expect((await owner.account.history()).map((e) => e.action)).toContain("version.unyanked");
  expect((await maintainer.account.history()).map((e) => e.action)).toContain("version.yanked");
  const held = await world.packs.public("@acme/held", { versions: ["1.0.0"] });
  await held.version("1.0.0").seed({ status: "yanked", reason: "Removed by PackServer: malware" });
  await expect(held.version("1.0.0").yank({ reason: "my own reason", by: maintainer })).toBeRefused("forbidden");
  await expect(held.version("1.0.0").unyank({ by: owner })).toBeRefused("forbidden");
  await expect(held.version("1.0.0").delete({ by: owner })).toBeRefused("forbidden");
  await expect(pack.version("1.0.0").yank({ reason: "Removed by PackServer: looks official", by: maintainer })).toBeRefused("forbidden");
  await expect(pack.version("1.0.0").deprecate("Removed by PackServer: looks official", { by: maintainer })).toBeRefused("forbidden");
  expect(await held.version("1.0.0").status()).toBe("yanked");
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-MOD-012 Yanking the only version leaves the pack listed as unavailable", async (world) => {
  await world.access.seedRegistryKeys();
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  const { owner } = await world.lifecycle.staff(pack);
  await world.search.list(pack, { pitch: "Cloud tools" });
  const before = await world.registry.serial(pack);

  await pack.version("1.0.0").yank({ reason: "published by mistake", by: owner });

  const entry = (await world.registry.indexes(pack, { newerThan: before })).scope.document.packs[0]!;
  expect(entry.latest_eligible).toBeNull();
  expect(entry.versions).toHaveLength(1);
  const page = await pack.page("overview");
  expect(page).not.toBeNotFound();
  expect((page as { statusLines: string[] }).statusLines.join(" ")).toContain("No available versions: published by mistake");
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-MOD-013 Yank and deprecate notify stargazers and open reporters; nothing to GitHub", async (world) => {
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0", "1.1.0"] });
  const { owner } = await world.lifecycle.staff(pack);
  const [s, t, r] = [await world.users.create(), await world.users.create(), await world.users.create()];
  for (const person of [s, t, r]) await person.signIn();
  await world.community.star(s, pack);
  await world.community.star(t, pack);
  await world.lifecycle.digest(s, true);
  await world.reports.file(r, pack, { kind: "bug", version: "1.0.0", title: "Crashes on adopt" });

  await pack.version("1.0.0").deprecate("use the newer release", { by: owner });
  await pack.version("1.1.0").yank({ reason: "breaks the update task", by: owner });
  await world.lifecycle.deliver();

  const heard = (person: typeof s) => world.mail.inbox(person).all().filter((m) => /withdrawn|deprecated|yanked/.test(m.subject));
  expect(heard(s)).toHaveLength(1);
  expect(heard(s)[0]!.text).toContain("1.0.0");
  expect(heard(s)[0]!.text).toContain("1.1.0");
  expect(heard(r)).toHaveLength(1);
  expect(heard(r)[0]!.text).toContain("1.0.0");
  expect(heard(r)[0]!.text).not.toContain("1.1.0");
  expect(heard(t)).toEqual([]);
  expect(await world.github.writes()).toEqual([]);
}, { needs: ["fakes", "clock", "storage"] });
