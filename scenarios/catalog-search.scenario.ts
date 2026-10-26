import { expect, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

// The Logpush archive is written to the admin Worker's ops bucket and the rollup reads the registry database, both through the storage seam.
const ROLLUP: ScenarioOpts = { needs: ["fakes", "storage", "clock", "reset"] };

const listed = async (world: World, name: string) => {
  const pack = await world.packs.public(name);
  await world.search.list(pack, { pitch: `Pack ${name}`, category: "workflow" });
  return pack;
};

scenario(
  "IT-TELEM-003 30-day fetch counts roll up hourly and show as aggregates",
  async (world) => {
    const pack = await listed(world, "@acme/lib");
    const priv = await world.packs.public("@acme/internal", { visibility: "private" });

    // Ten downloads yesterday from three networks, five from five networks 31 days ago, and two principals on the private pack.
    for (const from of ["198.51.100.7", "203.0.113.5", "192.0.2.44"]) await world.rollups.download(pack, { from, times: 3, ago: "1d" });
    await world.rollups.download(pack, { from: "198.51.100.7", ago: "1d" });
    await world.rollups.download(pack, { networks: 5, ago: "31d" });
    await world.rollups.privateDownload(priv, { principal: "hashed-a" });
    await world.rollups.privateDownload(priv, { principal: "hashed-b" });
    await world.rollups.run();

    // About ten, in order of magnitude (the archive is sampled and rescaled); the 31-day-old downloads are not in it.
    const count = (await world.rollups.stats(pack)).fetches30d as number;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThan(8);
    const card = (await world.search.site("Pack lib")).cards.find((c) => c.id === pack.name);
    expect(card?.fetches_30d).toBe(count);
    const mcp = await world.agents.anonymous().pack(pack);
    expect(mcp.body).toMatchObject({ signals: { fetches_30d: count } });
    expect(await world.rollups.stats(priv)).toMatchObject({ fetches30d: 2 });

    // Counts are approximate but monotonic: more distinct callers never lower them, and a replayed hour changes nothing.
    await world.clock.advance("1h");
    await world.rollups.run();
    expect((await world.rollups.stats(pack)).fetches30d).toBe(count);
    await world.rollups.download(pack, { from: "198.18.0.1" });
    await world.clock.advance("1h");
    await world.rollups.run();
    expect((await world.rollups.stats(pack)).fetches30d).toBeGreaterThan(count);

    // Thirty-one days on, yesterday's downloads have left the window and the count is a real zero.
    await world.clock.advance("31d");
    await world.rollups.ageWindows();
    expect(await world.rollups.stats(pack)).toMatchObject({ fetches30d: 0, fetches7d: 0 });
  },
  ROLLUP,
);
