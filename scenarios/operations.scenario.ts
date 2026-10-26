import { expect, Held, scenario } from "@packserver/test-world";
import type { ScenarioOpts, World } from "@packserver/test-world";

const SCAN: ScenarioOpts = { needs: ["fakes", "storage", "clock", "reset"] };
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
  "IT-TELEM-007 The weekly public-repository scan counts declaring repos",
  async (world) => {
    const g = world.github;
    const gcp = await world.packs.public("@acme/gcp");
    const aws = await world.packs.public("@acme/aws");

    // Last week: five public repositories declare gcp, two of them pinned to 1.0.0.
    for (let i = 1; i <= 5; i++) {
      g.publicRepo(`org${i}/app`, { declares: [i <= 2 ? { pack: gcp, version: "1.0.0" } : gcp] });
    }
    g.publicRepo("org10/hidden", { declares: [gcp], private: true });
    g.codeSearch.leakPrivateRepositories();

    const first = await g.scan.run();
    expect(first.outcome).toBe("completed");
    expect(await g.scan.adoption(gcp)).toMatchObject({ declaringRepositories: 5, pinnedVersions: { "1.0.0": 2 }, unpinned: 3, dropped: 0, label: "approximate, weekly" });
    expect(await g.scan.adoption(aws)).toMatchObject({ declaringRepositories: 0 });

    // The queries were split by pack id (and by file size where one pack matches too many files), and every one used the read-only public token.
    const queries = g.codeSearch.queries().map((q) => world.unalias(q));
    for (const pack of ["@acme/gcp", "@acme/aws"]) expect(queries.some((q) => q.startsWith(`"${pack}"`))).toBe(true);
    expect(g.codeSearch.credentials()).toEqual(["code-search"]);
    expect(g.codeSearch.privateRepositoryRequests()).toEqual([]);

    // A pack published after the scan began was never searched for: its count is unknown, not zero.
    await world.clock.advance("1m");
    const late = await world.packs.public("@acme/late");
    expect((await g.scan.adoption(late)).declaringRepositories).toBeNull();

    // The scan is weekly: asked again at once it does nothing, and it never created a scan to resume.
    expect((await g.scan.run()).outcome).toBe("idle");
    expect(await g.scan.cursor()).toBeNull();

    // This week one fewer repository declares gcp. GitHub answers slowly, past the run's 10 minutes.
    await world.clock.advance("7d");
    g.publicRepo("org5/app", { declares: [] });
    const weekOne = g.codeSearch.queries().length;
    g.codeSearch.slowBy("11m");
    const slow = await g.scan.run();
    expect(slow.outcome).toBe("deadline");
    const saved = await g.scan.cursor();
    expect(saved).not.toBeNull();
    expect(await g.scan.adoption(gcp)).toMatchObject({ declaringRepositories: 5 });
    const searched = g.codeSearch.queries().length;
    expect(searched - weekOne).toBe(1);

    // The next run resumes from the cursor: it searches only what is left, and completes.
    g.codeSearch.slowBy(null);
    const resumed = await g.scan.run();
    expect(resumed.outcome).toBe("completed");
    const thisWeek = g.codeSearch.queries().slice(weekOne);
    expect(new Set(thisWeek).size).toBe(thisWeek.length);
    expect(await g.scan.cursor()).toBeNull();
    expect(await g.scan.completed()).toBe(2);

    // The count, the pins and the dropped declaration are what the page, ranking and Trending read.
    expect(await g.scan.adoption(gcp)).toMatchObject({ declaringRepositories: 4, pinnedVersions: { "1.0.0": 2 }, unpinned: 2, dropped: 1, label: "approximate, weekly" });

    // The owner of a repository the scan found declaring the pack is a verified adopter; one whose declaration was dropped is not.
    expect(await g.scan.verifiedAdopter("org1", gcp)).toBe(true);
    expect(await g.scan.verifiedAdopter("org5", gcp)).toBe(false);
    expect(await g.scan.verifiedAdopter("org1", aws)).toBe(false);

    // A private repository was never read, whatever the search handed back; nothing was written to GitHub.
    expect(g.codeSearch.privateRepositoryRequests()).toEqual([]);
    expect(g.codeSearch.credentials()).toEqual(["code-search"]);
    expect(await g.writes()).toEqual([]);
  },
  SCAN,
);

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
