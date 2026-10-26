import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts } from "@packserver/test-world";

const SCAN: ScenarioOpts = { needs: ["fakes", "storage", "clock", "reset"] };

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

scenario("IT-OPS-002 A probe credential cannot act outside its scope", async (world) => {
  const outsideTheScope = ["publish-other-pack", "read-private-pack", "mint-token", "list-sessions", "change-email", "create-pack-in-probe"] as const;
  const browserOnly = ["read-private-pack", "mint-token", "list-sessions", "change-email"] as const;
  const probe = await world.probe.publisher();
  await (await probe.publish(world.archive("gcp", { version: "1.0.0" }), "1.0.0")).finished();

  // The one thing the probe repository's token may do: a new version of the pack it is registered for.
  expect(await world.probe.attempt("publish-new-version-of-probe-pack")).toBe(true);
  await (await probe.publish(world.archive("gcp", { version: "1.1.0" }), "1.1.0")).finished();

  for (const action of outsideTheScope) expect(await world.probe.attempt(action), action).toBe(false);
  // Presented where a browser session belongs, the token is not one.
  for (const action of browserOnly) expect(await world.probe.attempt(action, { asSession: true }), `${action} as a session`).toBe(false);
}, SCAN);
