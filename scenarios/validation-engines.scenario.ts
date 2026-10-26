import { expect, scenario, validate, rulesOf } from "@packserver/test-world";

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

scenario("IT-VAL-012 The prose screen runs last and reads changed files in full; there is no diff mode", async (world) => {
  const publisher = await world.publishers.create({ handle: "pro" });
  const order = ["admission", "integrity", "extraction", "manifest", "text", "capabilities", "canonical", "load", "source", "prose-screen", "thresholds", "verdict"];

  const secret = await validate(world, publisher, "pro", world.archive("with-secret"), "1.0.0");
  expect(await secret.verdict()).toBe("fail");
  expect((await secret.milestones()).find((m) => m.step === "prose-screen")).toMatchObject({ outcome: "skipped", detail: "earlier-failure" });

  const clean = await validate(world, publisher, "pro", world.archive("gcp", { version: "1.0.1" }), "1.0.1");
  const steps = (await clean.milestones()).map((m) => m.step);
  expect(steps).toEqual(order);
  expect((await clean.milestones()).find((m) => m.step === "prose-screen")).toMatchObject({ outcome: "ok" });
  expect(await clean.verdict()).toBe("warn");

  const unrequested = await publisher.dryRun(world.archive("gcp", { version: "1.0.2" }));
  await unrequested.finished();
  expect((await unrequested.milestones()).find((m) => m.step === "prose-screen")).toMatchObject({ outcome: "skipped", detail: "not-requested" });
  const requested = await publisher.dryRun(world.archive("gcp", { version: "1.0.3", files: { "README.md": "# asked for\n" } }), { proseScreen: true });
  await requested.finished();
  expect((await requested.milestones()).find((m) => m.step === "prose-screen")).toMatchObject({ outcome: "ok" });
});
