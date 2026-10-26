import { expect, scenario, type ScenarioOpts, type SearchFilters, type SearchResults, type World } from "@packserver/test-world";

// Seeds are dated against the system clock (promoted: "10d" is ten days before now) because the Workers do not read the fake clock.
const storage: ScenarioOpts = { needs: ["storage", "fakes"] };
// Scenarios that count or order the whole catalogue start from an empty one; the rest keep to words and categories of their own.
const empty: ScenarioOpts = { needs: ["storage", "fakes", "reset"] };

/** Site and search service answer from the one implementation, so every shared call returns the same ids in the same order. */
async function ask(world: World, query: string | undefined, filters: SearchFilters = {}): Promise<SearchResults> {
  const site = await world.search.site(query, filters);
  const service = await world.search.service(query, filters);
  expect(site.ids).toEqual(service.ids);
  expect(site.degraded).toBe(service.degraded);
  return site;
}

scenario("IT-SEARCH-003 Task-phrased queries match by meaning; filters apply on site and MCP alike", async (world) => {
  const task = "deploy to GCP Cloud Run";
  const run = await world.packs.public("@acme/run", { verification: { verified: true, verifiedDomain: "acme.test" } });
  const keyword = await world.packs.public("@kite/cloudrun");
  await world.search.list(run, {
    pitch: "Run containers on Google Cloud",
    category: "cloud",
    parts: ["rules", "skills"],
    repository: "github.com/acme/run",
    nearTo: [task],
  });
  await world.search.list(keyword, { pitch: "Cloud Run deploy helper for GCP", category: "data", parts: ["checks"] });

  expect((await ask(world, task)).ids.sort()).toEqual([run.name, keyword.name].sort());
  const filters: SearchFilters[] = [
    { category: "cloud" },
    { part: "skills" },
    { verifiedPublisher: true },
    { verifiedDomains: ["acme.test"] },
    { hasRepository: true },
  ];
  for (const filter of filters) expect((await ask(world, task, filter)).ids).toEqual([run.name]);

  await world.search.budget(true);
  const worded = await ask(world, "gcp cloud run deploy");
  expect(worded).toMatchObject({ ids: [keyword.name], degraded: true });
  expect(await ask(world, task)).toMatchObject({ degraded: false });
}, storage);

scenario("IT-SEARCH-013 Site search and browse mirror MCP, with sorts, and the URL carries the state", async (world) => {
  const seeds = [
    { name: "a", score: 90, stars: 10, rating: 5, promoted: "100d", fetches: 100, category: "cloud", parts: ["rules" as const], verified: true, repository: "github.com/acme/a" },
    { name: "b", score: 80, stars: 500, rating: 3, promoted: "60d", fetches: 50, category: "data", parts: ["checks" as const] },
    { name: "c", score: 70, stars: 100, rating: 4, promoted: "1d", fetches: 9000, category: "cloud", parts: ["skills" as const] },
    { name: "d", score: 60, stars: 300, rating: 4.5, promoted: "30d", fetches: 400, category: "data", parts: ["rules" as const], repository: "github.com/acme/d" },
    { name: "e", score: 50, stars: 1, promoted: "5d", fetches: 2, category: "other", parts: ["skills" as const] },
  ];
  const packs = new Map<string, string>();
  for (const s of seeds) {
    const pack = await world.packs.public(`@acme/${s.name}`, s.verified ? { verification: { verified: true, verifiedDomain: "acme.test" } } : {});
    packs.set(s.name, pack.name);
    await world.search.list(pack, { pitch: `Pack ${s.name}`, category: s.category, parts: s.parts, score: s.score, promoted: s.promoted, ...(s.repository ? { repository: s.repository } : {}) });
    await world.search.signals(pack, { stars: s.stars, fetches: s.fetches, ...(s.rating ? { rating: s.rating } : {}) });
  }
  const named = (letters: string) => [...letters].map((l) => packs.get(l));

  const sorts = { score: "abcde", stars: "bdcae", rating: "adcbe", recent: "cedba", fetches: "cdabe" } as const;
  for (const [sort, order] of Object.entries(sorts)) {
    expect((await ask(world, undefined, { sort: sort as keyof typeof sorts })).ids).toEqual(named(order));
  }
  const narrowed: Array<[SearchFilters, string]> = [
    [{ category: "cloud" }, "ac"],
    [{ part: "skills" }, "ce"],
    [{ verifiedPublisher: true }, "a"],
    [{ hasRepository: true }, "ad"],
    [{ verifiedDomains: ["acme.test"] }, "a"],
  ];
  for (const [filter, order] of narrowed) expect((await ask(world, undefined, filter)).ids).toEqual(named(order));

  const reloaded = await world.search.site(undefined, { category: "cloud", sort: "fetches" });
  expect(reloaded.ids).toEqual((await world.search.site(undefined, { category: "cloud", sort: "fetches" })).ids);
  expect((await world.search.site()).ids).toEqual((await world.search.service()).ids);
}, empty);

scenario("IT-SEARCH-015 Positions 10, 20, … of a browse page are exploration slots once the catalogue holds 50 public packs", async (world) => {
  const add = async (name: string, score: number, promoted: string) => {
    const [id] = await world.search.fill([{ name: `@acme/${name}`, pitch: "Cloud thing", category: "cloud", score, promoted }]);
    return id as string;
  };
  const established = Array.from({ length: 40 }, (_, i) => ({ name: `@acme/est${String(i).padStart(2, "0")}`, pitch: "Cloud thing", category: "cloud", score: 95 - Math.floor((i * 34) / 39), promoted: "365d" }));
  const fresh = Array.from({ length: 9 }, (_, i) => ({ name: `@acme/new${i}`, pitch: "Cloud thing", category: "cloud", score: 60 + (i % 6), promoted: "3d" }));
  await world.search.fill([...established, ...fresh]);
  const recent = fresh.map((p) => p.name);

  const before = await world.search.site(undefined, { category: "cloud", limit: 50 });
  expect(before.slots).toEqual([]);
  const scores = before.cards.map((c) => c.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));

  const low = await add("low", 59, "2d");
  const fifty = await world.search.site(undefined, { category: "cloud", limit: 20 });
  expect(fifty.slots).toEqual([10, 20]);
  for (const slot of fifty.slots) {
    const card = fifty.cards[slot - 1];
    expect(recent).toContain(card?.id);
    expect(card).toMatchObject({ verified: false });
    expect(before.ids.indexOf(card?.id as string)).toBeGreaterThanOrEqual(slot);
  }
  const taken = fifty.slots.map((slot) => fifty.ids[slot - 1]);
  const plain = [...before.ids, low].filter((id) => !taken.includes(id));
  expect(fifty.cards.filter((c) => !c.exploration).map((c) => c.id)).toEqual(plain.slice(0, 18));

  const old = await add("old", 80, "91d");
  const withOld = await world.search.site(undefined, { category: "cloud", limit: 30 });
  expect(withOld.slots).toEqual([10, 20, 30]);
  expect(withOld.cards.filter((c) => c.exploration).map((c) => c.id)).not.toContain(old);
  expect(withOld.cards.filter((c) => c.exploration).map((c) => c.id)).not.toContain(low);
  expect(withOld.ids).toContain(old);
}, empty);

scenario("IT-SEARCH-020 Fixed categories and free tags", async (world) => {
  const run = await world.packs.public("@acme/run");
  await world.search.list(run, { pitch: "Run containers", category: "cloud", tags: ["gcp", "cloudrun", "serverless"] });
  const odd = await world.packs.public("@acme/odd");
  await expect(world.search.list(odd, { pitch: "Something", category: "made-up" })).toBeRefused("category");

  const categories = await world.search.categories();
  expect(categories.map((c) => c.category)).not.toContain("made-up");
  expect(categories.find((c) => c.category === "cloud")).toEqual({ category: "cloud", count: 1 });
  expect(categories.reduce((n, c) => n + c.count, 0)).toBe(1);
  expect((await ask(world, undefined, { category: "cloud" })).ids).toEqual([run.name]);
  expect((await ask(world, "cloudrun")).ids).toEqual([run.name]);
  expect((await ask(world, "made-up")).ids).toEqual([]);
}, empty);

scenario("IT-SEARCH-021 The default sort is the pack score", async (world) => {
  const query = "serverless deploy";
  const low = await world.packs.public("@acme/l");
  const high = await world.packs.public("@acme/h");
  await world.search.list(low, { pitch: "Serverless deploy", category: "security", score: 90, promoted: "365d" });
  await world.search.signals(low, { stars: 0, fetches: 0 });
  await world.search.list(high, { pitch: "Serverless deploy", category: "security", score: 50, promoted: "1d" });
  await world.search.signals(high, { stars: 500, rating: 5, fetches: 10000 });

  expect((await ask(world, undefined, { category: "security" })).ids).toEqual([low.name, high.name]);
  expect((await ask(world, query)).ids).toEqual([low.name, high.name]);
  expect((await ask(world, query, { sort: "stars" })).ids).toEqual([high.name, low.name]);
}, storage);

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

  await world.search.demote(one, "advisory");
  await world.search.demote(two, "failed_validation");
  await world.search.demote(three, "abuse_hold");
  const demoted = await ask(world, query);
  expect(demoted.ids).toEqual([four.name, one.name, two.name, three.name]);
  expect((await ask(world, undefined, { category: "backend" })).ids[0]).toBe(four.name);

  await world.search.demote(one, null);
  await world.search.demote(two, null);
  await world.search.demote(three, null);
  expect((await ask(world, query)).ids).toEqual(original);
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
