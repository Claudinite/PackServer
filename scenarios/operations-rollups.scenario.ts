import { expect, Held, scenario } from "@packserver/test-world";
import type { ScenarioOpts, World } from "@packserver/test-world";

// The Logpush archive is written to the admin Worker's ops bucket and the rollup reads the registry database, both through the storage seam.
const ROLLUP: ScenarioOpts = { needs: ["fakes", "storage", "clock", "reset"] };

/** A signed-in owner of a private pack of their own, holding a read token: an authenticated principal for a mismatch report. */
async function principal(world: World, handle: string) {
  const owner = await world.users.create({ handle });
  await owner.signIn();
  await owner.mfa.enrol();
  const secret = await world.packs.public(`@${handle}/secret`, { visibility: "private" });
  await world.tokens.seedOwner(owner, secret);
  return owner.tokens.mint({ read: secret });
}

scenario(
  "IT-TELEM-001 Downloads and index fetches are counted without blocking",
  async (world) => {
    const pack = await world.packs.public("@acme/lib");
    const priv = await world.packs.public("@acme/internal", { visibility: "private" });
    const before = (await world.recorder.invocations()).length;

    // A public download reaches the zone's request log with the caller's /24 network and no address.
    await world.rollups.download(pack, { from: "198.51.100.77" });
    // The serving Worker's analytics points for private fetches: two principals, one of them twice.
    await world.rollups.privateDownload(priv, { principal: "hashed-a" });
    await world.rollups.privateDownload(priv, { principal: "hashed-a" });
    await world.rollups.privateDownload(priv, { principal: "hashed-b" });

    const run = await world.rollups.run();
    expect(run.ran).toEqual(["hits", "misses", "downloads"]);
    expect(run.privateDownloads).toBe("folded");

    // The public download is counted from the archive; it produced no Worker invocation and no address was kept.
    expect(await world.rollups.stats(pack)).toMatchObject({ fetches30d: 1, distinct30d: 1 });
    expect((await world.recorder.invocations()).length).toBe(before);
    expect((await world.rollups.perDay(pack)).length).toBe(1);

    // A private pack is counted once per principal.
    expect(await world.rollups.stats(priv)).toMatchObject({ fetches30d: 2, distinct30d: 2 });

    // Where the analytics read is not configured the private counts are left as they were, not set to zero.
    await world.clock.advance("1h");
    const unconfigured = await world.rollups.run({ private: false });
    expect(unconfigured.privateDownloads).toBe("not_configured");
    expect(await world.rollups.stats(priv)).toMatchObject({ fetches30d: 2 });
  },
  ROLLUP,
);

scenario(
  "IT-TELEM-002 A public download counts once per network, version and day; a private one once per principal",
  async (world) => {
    const pack = await world.packs.public("@acme/lib", { versions: ["1.0.0", "2.0.0"] });
    const priv = await world.packs.public("@acme/internal", { visibility: "private" });

    for (let i = 0; i < 5; i++) await world.rollups.download(pack, { from: "198.51.100.7" });
    await world.rollups.download(pack, { from: "198.51.100.9" });
    await world.rollups.download(pack, { from: "2001:db8::1" });
    await world.rollups.download(pack, { from: "2001:db8:0:0:5::9" });
    for (let i = 0; i < 5; i++) await world.rollups.privateDownload(priv, { principal: "hashed-a" });
    await world.rollups.run();

    const today = (await world.clock.now()).toISOString().slice(0, 10);
    // 198.51.100.7 and .9 share a /24; the two IPv6 addresses share a /48.
    expect(await world.rollups.perDay(pack)).toEqual([{ version: "1.0.0", day: today, fetches: 2 }]);
    expect(await world.rollups.perDay(priv)).toEqual([{ version: "1.0.0", day: today, fetches: 1 }]);

    // The same network the next day counts again.
    await world.clock.advance("1d");
    const tomorrow = (await world.clock.now()).toISOString().slice(0, 10);
    await world.rollups.download(pack, { from: "198.51.100.7" });
    await world.rollups.run();
    expect(await world.rollups.perDay(pack)).toEqual([
      { version: "1.0.0", day: today, fetches: 2 },
      { version: "1.0.0", day: tomorrow, fetches: 1 },
    ]);

    // Pages say about N fetches and carry no repository count from them: that count is the weekly scan's, and unknown until it has run.
    const stats = await world.rollups.stats(pack);
    expect(stats.fetches30d).toBe(3);
    expect(stats.declaringRepositories).toBeNull();
    expect(await world.rollups.stats(priv)).toMatchObject({ fetches30d: 1 });
  },
  ROLLUP,
);

scenario(
  "IT-TELEM-009 Client mismatch reports never decide anything alone",
  async (world) => {
    const pack = await world.packs.public("@acme/lib", { versions: ["1.0.0", "2.0.0"] });
    const first = await principal(world, "ann");
    const second = await principal(world, "bob");
    const held = async (version: string) => (await pack.read({ version })) instanceof Held;

    // One principal reports, then reports again; an anonymous caller reports too.
    expect((await world.mismatches.report(pack, { token: first })).accepted).toBe(true);
    expect((await world.mismatches.report(pack, { token: first })).accepted).toBe(true);
    expect((await world.mismatches.report(pack)).accepted).toBe(true);
    expect(await held("1.0.0")).toBe(false);
    expect(await world.mismatches.listing(pack)).toEqual([{ version: "1.0.0", reports: 3, principals: 1, anonymous: 1, held: null }]);
    expect(await world.mismatches.cases(pack)).toEqual([]);

    // A report that expected some other hash is listed and never counts; neither does a bearer that is not a token.
    expect((await world.mismatches.report(pack, { token: second, expected: "c".repeat(64) })).accepted).toBe(true);
    expect((await world.mismatches.report(pack, { body: "not an object" })).accepted).toBe(true);
    expect(await held("1.0.0")).toBe(false);

    // The second distinct principal holds the version and the page signal goes out once.
    await world.mismatches.report(pack, { token: second });
    expect(await held("1.0.0")).toBe(true);
    expect(await world.mismatches.cases(pack)).toMatchObject([{ version: "1.0.0", trigger: "reports" }]);
    expect(await world.mismatches.listing(pack)).toMatchObject([{ version: "1.0.0", principals: 2, held: "reports" }]);
    await world.mismatches.report(pack, { token: second });
    expect(await world.mismatches.cases(pack)).toHaveLength(1);

    // A mismatch the serving Worker saw itself holds the version at once, with no client report.
    expect(await held("2.0.0")).toBe(false);
    expect(await world.mismatches.observedByServer(pack, "2.0.0")).toEqual({ quarantined: true });
    expect(await held("2.0.0")).toBe(true);
    expect(await world.mismatches.cases(pack)).toMatchObject([{ version: "1.0.0", trigger: "reports" }, { version: "2.0.0", trigger: "server" }]);
  },
  ROLLUP,
);

scenario(
  "IT-CN-012 What cn sends with a fetch",
  async (world) => {
    // The server half: the mismatch cn posts, in the shape and with the headers the engine sends, is accepted and kept.
    const pack = await world.packs.public("@acme/lib");
    const token = await principal(world, "ann");
    const answer = await world.mismatches.report(pack, { token, observed: "e".repeat(64) });
    expect(answer.accepted).toBe(true);
    expect(await world.mismatches.listing(pack)).toMatchObject([{ version: "1.0.0", reports: 1, principals: 1 }]);
  },
  ROLLUP,
);
