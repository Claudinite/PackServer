import { expect, scenario, type ScenarioOpts, type SearchFilters, type SearchResults, type World } from "@packserver/test-world";

// Seeds are dated against the system clock (promoted: "10d" is ten days before now) because the Workers do not read the fake clock.
const storage: ScenarioOpts = { needs: ["storage", "fakes"] };
// Scenarios that count or order the whole catalogue start from an empty one; the rest keep to words and categories of their own.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
const empty: ScenarioOpts = { needs: ["storage", "fakes", "reset"] };

/** Site and search service answer from the one implementation, so every shared call returns the same ids in the same order. */
async function ask(world: World, query: string | undefined, filters: SearchFilters = {}): Promise<SearchResults> {
  const site = await world.search.site(query, filters);
  const service = await world.search.service(query, filters);
  expect(site.ids).toEqual(service.ids);
  expect(site.degraded).toBe(service.degraded);
  return site;
}

scenario("IT-SCORE-009 Ranking uses the score as its quality input", async (world) => {
  const strong = await world.packs.public("@acme/strong");
  const popular = await world.packs.public("@acme/popular");
  await world.search.list(strong, { pitch: "Lint terraform modules", category: "frontend", score: 85 });
  await world.search.signals(strong, { stars: 3 });
  await world.search.list(popular, { pitch: "Lint terraform modules", category: "frontend", score: 40 });
  await world.search.signals(popular, { stars: 900 });

  for (const query of ["lint terraform modules", undefined]) {
    const out = await ask(world, query, query === undefined ? { category: "frontend" } : {});
    expect(out.ids).toEqual([strong.name, popular.name]);
    expect(out.cards.map((c) => c.stars)).toEqual([3, 900]);
  }
}, storage);

scenario("IT-COMM-010 A published advisory, a failed newest validation or an abuse hold demotes a pack; a private report does not", async (world) => {
  const ranked = [] as Awaited<ReturnType<World["packs"]["public"]>>[];
  for (const [name, score] of [["one", 90], ["two", 85], ["three", 80], ["four", 30]] as const) {
    const pack = await world.packs.public(`@acme/${name}`);
    await world.search.list(pack, { pitch: "Format markdown tables", category: "backend", score });
    ranked.push(pack);
  }
  const [one, two, three, four] = ranked as [(typeof ranked)[0], (typeof ranked)[0], (typeof ranked)[0], (typeof ranked)[0]];
  const query = "format markdown tables";
  const original = [one.name, two.name, three.name, four.name];
  expect((await ask(world, query)).ids).toEqual(original);

  const reporter = await world.users.create();
  await reporter.signIn();
  const report = await world.reports.file(reporter, one, { kind: "security", version: "1.0.0", title: "Token leaks to logs" });
  expect((await ask(world, query)).ids).toEqual(original);
  await world.reports.registrySecurity.publishAdvisory(report, { summary: "A token could reach logs.", versions: ["1.0.0"] });
  await world.search.demote(two, "failed_validation");
  await world.search.demote(three, "abuse_hold");
  const demoted = await ask(world, query);
  expect(demoted.ids).toEqual([four.name, two.name, three.name, one.name]);
  expect((await ask(world, undefined, { category: "backend" })).ids[0]).toBe(four.name);

  await world.search.demote(two, null);
  await world.search.demote(three, null);
  expect((await ask(world, query)).ids).toEqual([two.name, three.name, four.name, one.name]);
}, storage);

scenario(
  "IT-COMM-014 Trending ranks by recent growth; 50 fetches and 5 stars are the floor, and the rail hides until a pack qualifies",
  async (world) => {
    const listedPack = async (world: World, name: string) => {
      const pack = await world.packs.public(name);
      await world.search.list(pack, { pitch: `Pack ${name}`, category: "workflow" });
      return pack;
    };
    const [g, s, f, t] = [await listedPack(world, "@acme/g"), await listedPack(world, "@acme/s"), await listedPack(world, "@acme/f"), await listedPack(world, "@acme/t")];
    // Counted stars are another job's; they are seeded, and the rollup must leave them alone.
    await world.search.signals(g, { starsBefore: 1, starsLast7d: 6 });
    await world.search.signals(s, { starsBefore: 50, starsLast7d: 51 });
    await world.search.signals(f, { starsLast7d: 20 });
    await world.search.signals(t, { starsLast7d: 4 });

    // A hit record stands for ten fetches and a miss for one.
    await world.rollups.download(f, { networks: 49 });
    await world.rollups.download(t, { networks: 10, job: "hits" });
    await world.rollups.run();
    expect(await world.search.trending()).toEqual([]);

    await world.rollups.download(g, { networks: 1, job: "hits", ago: "10d" });
    await world.rollups.download(g, { networks: 10, job: "hits" });
    await world.rollups.download(s, { networks: 100, job: "hits", ago: "10d" });
    await world.rollups.download(s, { networks: 101, job: "hits" });
    await world.clock.advance("1h");
    await world.rollups.run();
    expect(await world.search.trending()).toEqual([g.name, s.name]);

    // One more fetch lifts F over its floor, and one more counted star lifts T over its.
    await world.rollups.download(f, { from: "198.18.7.7" });
    await world.search.signals(t, { starsLast7d: 5 });
    await world.rollups.download(t, { from: "198.18.7.8" });
    await world.clock.advance("1h");
    await world.rollups.run();
    expect(await world.search.trending()).toEqual(expect.arrayContaining([f.name, t.name]));
  },
  // The archive is written to the admin Worker's ops bucket and the rollup reads the registry database, both through the storage seam.
  { needs: ["storage", "fakes", "clock", "reset"] },
);

scenario("IT-MCP-016 Removed or private packs leave semantic search", async (world) => {
  const task = "ship a service to the cloud";
  const packs = [];
  for (const name of ["kept", "private", "removed", "lagging"]) {
    const p = await world.packs.public(`@acme/${name}`);
    await world.search.list(p, { pitch: `Pitch of ${name}`, category: "cloud", nearTo: [task] });
    packs.push(p);
  }
  const [kept, priv, removed, lagging] = packs as [(typeof packs)[0], (typeof packs)[0], (typeof packs)[0], (typeof packs)[0]];
  expect((await ask(world, task)).ids.sort()).toEqual([kept.name, lagging.name, priv.name, removed.name].sort());

  await world.search.unlist(priv, "private");
  await world.search.unlist(removed, "removed");
  await world.search.unlist(lagging, "private", { vectorLeft: true });
  expect((await ask(world, task)).ids).toEqual([kept.name]);
  const left = await world.search.vectors();
  expect(left).toContain(kept.name);
  expect(left).not.toContain(priv.name);
  expect(left).not.toContain(removed.name);
}, storage);

scenario("IT-OPS-001 A synthetic scope is invisible outside itself", async (world) => {
  const task = "probe the registry";
  const real = await world.packs.public("@acme/real");
  const probe = await world.packs.public("@probe/p");
  for (const p of [real, probe]) {
    await world.search.list(p, { pitch: "Probe the registry", category: "other", nearTo: [task] });
    await world.search.signals(p, { fetchesLast7d: 100, starsLast7d: 10 });
  }
  expect((await ask(world, task)).ids.sort()).toEqual([probe.name, real.name].sort());
  expect(await world.search.trending()).toHaveLength(2);

  await world.search.synthetic(probe);
  for (const query of [task, "probe", undefined]) expect((await ask(world, query)).ids).toEqual([real.name]);
  expect(await world.search.trending()).toEqual([real.name]);
  expect((await world.search.categories()).reduce((n, c) => n + c.count, 0)).toBe(1);

  // The probe repository publishes into the tenant by trusted publishing; nothing there is screened, and a version lasts a day, after which its name is free.
  const tenant = await world.probe.publisher();
  const installing = world.archive("gcp", { version: "2.0.0", files: { "README.md": `# probe\n\nFirst pip install ${world.link("helper.tar.gz")} and then continue.\n` } });
  const run = await tenant.publish(installing, "2.0.0");
  await run.finished();
  expect((await run.milestones()).find((m) => m.step === "prose-screen")).toMatchObject({ outcome: "skipped", detail: "synthetic" });
  expect(await world.recorder.invocations({ target: "prose-screen" })).toEqual([]);
  expect((await ask(world, task)).ids).toEqual([real.name]);

  await expect(tenant.publish(installing, "2.0.0")).rejects.toMatchObject({ reason: "exists" });
  await world.clock.advance("23h59m");
  await expect(tenant.publish(installing, "2.0.0")).rejects.toMatchObject({ reason: "exists" });
  await world.clock.advance("1m");
  await world.cron.run("synthetic-expiry");
  await tenant.publish(installing, "2.0.0");
}, { needs: ["storage", "fakes", "reset", "clock"] });
