import { expect, scenario, type Run, type World } from "@packserver/test-world";

type Publisher = Awaited<ReturnType<World["publishers"]["create"]>>;

/** Publishes `archive` as the next version of `@<handle>/tool` and waits for its verdict. */
async function validate(world: World, publisher: Publisher, handle: string, archive: ReturnType<World["archive"]>, version: string): Promise<Run> {
  return world.validation.completes(await publisher.publish(archive).as(`@${handle}/tool@${version}`));
}


scenario("IT-VAL-014 Infrastructure errors retry and cost nothing; extraction failures are final", async (world) => {
  const publisher = await world.publishers.create({ handle: "inf" });

  const flaky = world.archive("gcp", { version: "1.0.0" });
  await world.sandbox.script(flaky, { errorTimes: 2 });
  const recovered = await validate(world, publisher, "inf", flaky, "1.0.0");
  expect(await recovered.verdict()).toBe("warn");
  expect((await world.sandbox.calls()).ran).toHaveLength(3);
  expect((await world.sandbox.calls()).inspected).toHaveLength(1);

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
