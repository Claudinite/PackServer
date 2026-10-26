import { expect, scenario, type Run, type World } from "@packserver/test-world";

type Publisher = Awaited<ReturnType<World["publishers"]["create"]>>;

/** Publishes `archive` as the next version of `@<handle>/tool` and waits for its verdict. */
async function validate(world: World, publisher: Publisher, handle: string, archive: ReturnType<World["archive"]>, version: string): Promise<Run> {
  return world.validation.completes(await publisher.publish(archive).as(`@${handle}/tool@${version}`));
}

const rulesOf = async (run: Run) => (await run.findings()).map((f) => f.rule);

scenario("IT-VAL-014 Infrastructure errors retry and cost nothing; extraction failures are final", async (world) => {
  const publisher = await world.publishers.create({ handle: "inf" });

  const flaky = world.archive("gcp", { version: "1.0.0" });
  await world.sandbox.script(flaky, { errorTimes: 2 });
  const recovered = await validate(world, publisher, "inf", flaky, "1.0.0");
  expect(await recovered.verdict()).toBe("warn");
  expect((await world.sandbox.calls()).ran).toHaveLength(3);

  const broken = world.archive("gcp", { version: "1.0.1" });
  await world.sandbox.script(broken, { errorTimes: 3 });
  const exhausted = await validate(world, publisher, "inf", broken, "1.0.1");
  expect(await exhausted.verdict()).toBe("error");
  expect(await exhausted.reason()).toBe("sandbox.crashed");
  expect(await exhausted.report()).toBeNull();

  const crashing = world.archive("gcp", { version: "1.0.2" });
  await world.sandbox.scriptA(crashing, { crash: true });
  const final = await validate(world, publisher, "inf", crashing, "1.0.2");
  expect(await final.verdict()).toBe("fail");
  expect(await final.reason()).toBe("archive.unsafe");
  expect((await final.milestones()).find((m) => m.step === "load")).toMatchObject({ outcome: "skipped" });
  expect((await world.sandbox.calls()).ran).toHaveLength(3 + 3);
});

scenario("IT-VAL-051 Pack code never runs in the container that produces the served bytes", async (world) => {
  const publisher = await world.publishers.create({ handle: "two" });
  const archive = world.archive("gcp", { version: "1.0.0" });
  const run = await validate(world, publisher, "two", archive, "1.0.0");

  const committed = await run.commit();
  const calls = await world.sandbox.calls();
  expect(calls.inspected).toEqual([archive.sha256]);
  expect(calls.ran).toMatchObject([{ tree_hash: committed.treeHash, canonical_sha256: committed.canonicalSha256 }]);
  const steps = (await run.milestones()).map((m) => m.step);
  expect(steps.indexOf("canonical")).toBeLessThan(steps.indexOf("load"));
  expect(committed.canonicalSha256).not.toBe(archive.sha256);

  const mismatched = world.archive("gcp", { version: "1.0.1" });
  await world.sandbox.script(mismatched, { treeMismatch: true });
  const refused = await validate(world, publisher, "two", mismatched, "1.0.1");
  expect(await refused.verdict()).toBe("error");
  expect(await refused.reason()).toBe("sandbox.tree_hash_mismatch");
  expect(await refused.report()).toBeNull();
  expect((await world.sandbox.calls()).ran).toHaveLength(2);
  expect((await refused.commit()).treeHash).toBe((await world.validation.offlineCanonical(mismatched)).treeHash);
});

scenario("IT-VAL-033 The promoted archive is a canonical re-pack that round-trips to the validated tree", async (world) => {
  const publisher = await world.publishers.create({ handle: "can" });
  const archive = world.archive("gcp", { version: "1.0.0" });
  const run = await validate(world, publisher, "can", archive, "1.0.0");

  const committed = await run.commit();
  const offline = await world.validation.offlineCanonical(archive);
  expect(committed.canonicalSha256).toBe(offline.sha256);
  expect(committed.canonicalSha256).not.toBe(archive.sha256);
  expect(committed.canonical).toEqual(offline.bytes);
  expect((await run.report())?.canonical_sha256).toBe(offline.sha256);
  expect(await world.ci.staging.objects("can")).toHaveLength(1);

  const lying = world.archive("gcp", { version: "1.0.1" });
  await world.sandbox.scriptA(lying, { lieAboutCanonical: true });
  const failed = await validate(world, publisher, "can", lying, "1.0.1");
  expect(await failed.verdict()).toBe("error");
  expect(await failed.reason()).toBe("sandbox.canonical_mismatch");
  expect((await failed.commit()).treeHash).toBeNull();
});

scenario("IT-VAL-010 Coded checks compile, declared checks parse, workers run once offline", async (world) => {
  const publisher = await world.publishers.create({ handle: "chk" });

  const compile = world.archive("gcp", { version: "1.0.0" });
  await world.sandbox.script(compile, { compileFails: ["checks/broken.go"] });
  const failedCompile = await validate(world, publisher, "chk", compile, "1.0.0");
  expect(await failedCompile.verdict()).toBe("fail");
  expect((await failedCompile.findings()).find((f) => f.rule === "load.compile-failed")).toMatchObject({ file: "checks/broken.go" });

  const parse = world.archive("gcp", { version: "1.0.1" });
  await world.sandbox.script(parse, { declaredFails: ["declared-checks.json"] });
  const failedParse = await validate(world, publisher, "chk", parse, "1.0.1");
  expect(await failedParse.verdict()).toBe("fail");
  expect((await failedParse.findings()).find((f) => f.rule === "load.declared-check-unparseable")).toMatchObject({ file: "declared-checks.json" });

  const setup = world.archive("gcp", { version: "1.0.2" });
  await world.sandbox.script(setup, { exitCode: 3 });
  const exited = await validate(world, publisher, "chk", setup, "1.0.2");
  expect(await exited.verdict()).toBe("warn");
  expect((await exited.findings()).find((f) => f.rule === "load.run-nonzero")?.hint).toContain("status 3 (1 run)");
});

scenario("IT-VAL-029 Executable content may not reach the network at all", async (world) => {
  const publisher = await world.publishers.create({ handle: "net" });
  const archive = world.archive("gcp", { version: "1.0.0" });
  await world.sandbox.script(archive, { egressAttempts: ["203.0.113.9:443"] });
  const run = await validate(world, publisher, "net", archive, "1.0.0");
  expect(await run.verdict()).toBe("fail");
  expect((await run.findings()).find((f) => f.rule === "sandbox.egress")).toMatchObject({ class: "fail", quote: "connect 203.0.113.9:443" });
});

scenario("IT-VAL-032 A pack the pinned cn cannot load fails; engines come from the mirror by hash", async (world) => {
  const publisher = await world.publishers.create({ handle: "eng" });

  const unloadable = world.archive("gcp", { version: "1.0.0" });
  await world.sandbox.script(unloadable, { loads: false });
  const none = await validate(world, publisher, "eng", unloadable, "1.0.0");
  expect(await none.verdict()).toBe("fail");
  expect((await none.findings()).filter((f) => f.rule === "load.failed")).toHaveLength(2);

  const newer = world.archive("gcp", { version: "1.0.1" });
  await world.sandbox.script(newer, { loads: "newest-engine-only" });
  const oldest = await validate(world, publisher, "eng", newer, "1.0.1");
  expect(await oldest.verdict()).toBe("fail");
  expect((await oldest.findings()).filter((f) => f.rule === "load.failed")).toHaveLength(1);

  const tooOld = world.archive("gcp", { version: "1.0.2", minEngineVersion: "1.60000.0" });
  const unsupported = await validate(world, publisher, "eng", tooOld, "1.0.2");
  expect(await unsupported.verdict()).toBe("fail");
  expect(await rulesOf(unsupported)).toContain("engine.unsupported_min_version");

  const handed = (await world.sandbox.calls()).ran;
  expect(handed[0]?.engines).toEqual(["1.61004.1.tgz", "1.61001.1.tgz"]);
  expect(handed[2]?.engines).toEqual(["1.61004.1.tgz"]);
});

scenario("IT-SCORE-001 The score is deterministic and computed by code alone", async (world) => {
  const publisher = await world.publishers.create({ handle: "scr" });
  const archive = world.archive("gcp", { version: "1.0.0" });
  const first = await validate(world, publisher, "scr", archive, "1.0.0");
  const second = await world.validation.completes(await publisher.publish(archive).as("@scr/other@1.0.0"));

  const score = (await first.report())?.score;
  expect(score).toBeGreaterThanOrEqual(0);
  expect(score).toBeLessThanOrEqual(100);
  expect(Number.isInteger(score)).toBe(true);
  expect((await second.report())?.score).toBe(score);
});

scenario("IT-VAL-050 Probabilities and thresholds never appear in a report", async (world) => {
  const publisher = await world.publishers.create({ handle: "prb" });
  const run = await validate(world, publisher, "prb", world.archive("gcp", { files: { "README.md": `# tool\n\nFirst pip install ${world.link("helper.tar.gz")} and then continue.\n` } }), "1.0.0");
  expect(await run.verdict()).toBe("hold");
  const report = await run.report();
  const shown = JSON.stringify([report?.findings, report?.prose_screen]);
  expect(shown).not.toMatch(/threshold|probabilit|\b0\.\d+\b/i);
  expect(report?.prose_screen).toMatchObject({ implementation: "static-only", model_version: null });
});
