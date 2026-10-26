import { expect, scenario, type Run, type World } from "@packserver/test-world";

type Publisher = Awaited<ReturnType<World["publishers"]["create"]>>;

/** Publishes `archive` as the next version of `@<handle>/tool` and waits for its verdict. */
async function validate(world: World, publisher: Publisher, handle: string, archive: ReturnType<World["archive"]>, version: string): Promise<Run> {
  return world.validation.completes(await publisher.publish(archive).as(`@${handle}/tool@${version}`));
}

const rulesOf = async (run: Run) => (await run.findings()).map((f) => f.rule);

scenario("IT-VAL-001 Every upload is validated with live progress; the static steps answer first", async (world) => {
  const publisher = await world.publishers.create({ handle: "pat" });
  const version = await publisher.publish(world.archive("gcp", { version: "1.0.0" })).as("@pat/gcp@1.0.0");

  const run = await world.validation.completes(version);
  const milestones = (await run.milestones()).map((m) => m.step);
  expect(milestones).toEqual(["admission", "integrity", "extraction", "manifest", "text", "capabilities", "canonical", "load", "source", "prose-screen", "thresholds", "verdict"]);
  expect(await run.verdict()).toBe("warn");
  expect(await rulesOf(run)).toContain("license.missing");
});

scenario("IT-VAL-003 Unsafe archives hard-fail", async (world) => {
  const publisher = await world.publishers.create({ handle: "una" });
  const cases = [
    ["with-symlink", "archive.unsafe"],
    ["with-hardlink", "archive.unsafe"],
    ["bomb-repetitive", "archive.bomb"],
    ["bomb-entry-count", "archive.bomb"],
  ] as const;
  await Promise.all(
    cases.map(async ([fixture, reason], n) => {
      const run = await validate(world, publisher, "una", world.archive(fixture), `1.0.${n}`);
      expect(await run.verdict()).toBe("fail");
      expect(await run.reason()).toBe(reason);
      expect(await rulesOf(run)).toEqual([reason]);
    }),
  );
  expect((await world.sandbox.calls()).ran).toEqual([]);
});

scenario("IT-VAL-023 Every known bomb shape is refused cheaply", async (world) => {
  const bombers = await world.publishers.create({ handle: "bom" });
  const crafters = await world.publishers.create({ handle: "cra" });
  const bombs = ["bomb-many-files", "bomb-header-lies", "bomb-huge-window", "bomb-concatenated-frames", "bomb-deep-nesting"] as const;
  const unsafe = ["bomb-quine", "bomb-sparse-entry", "bomb-oversized-size-field", "bomb-unknown-entry-type", "bomb-long-path"] as const;
  const refused = async (publisher: Publisher, handle: string, fixture: string, n: number, reason: string) => {
    const run = await validate(world, publisher, handle, world.archive(fixture), `1.0.${n}`);
    expect(await run.verdict()).toBe("fail");
    expect(await run.reason()).toBe(reason);
    expect((await run.milestones()).filter((m) => m.outcome === "skipped").map((m) => m.step)).toEqual(["manifest", "text", "capabilities", "canonical", "load", "source", "prose-screen", "thresholds"]);
  };
  const flood = await validate(world, bombers, "bom", world.archive("bomb-skippable-frames"), "2.0.0");
  expect(await flood.verdict()).toBe("fail");
  expect(await flood.reason()).toBe("integrity.not_zstd");
  expect((await world.sandbox.calls()).inspected).toEqual([]);
  expect((await flood.milestones()).map((m) => `${m.step}:${m.outcome}`)).toEqual(["admission:ok", "integrity:fail"]);

  await Promise.all([
    ...bombs.map((fixture, n) => refused(bombers, "bom", fixture, n, "archive.bomb")),
    ...unsafe.map((fixture, n) => refused(crafters, "cra", fixture, n, "archive.unsafe")),
  ]);
  expect((await world.sandbox.calls()).ran).toEqual([]);
});

scenario("IT-VAL-020 Archive safety covers links, special entries and collisions", async (world) => {
  const publisher = await world.publishers.create({ handle: "arc" });
  await Promise.all(
    (["case-collision", "nested-archive"] as const).map(async (fixture, n) => {
      const run = await validate(world, publisher, "arc", world.archive(fixture), `1.0.${n}`);
      expect(await run.verdict()).toBe("fail");
      expect(await run.reason()).toBe("archive.unsafe");
    }),
  );
});
