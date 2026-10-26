import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts } from "@packserver/test-world";

const SCAN: ScenarioOpts = { needs: ["fakes", "storage", "clock", "reset"] };

scenario(
  "IT-TELEM-007 The weekly public-repository scan counts declaring repos",
  async (world) => {
    const g = world.github;
    const gcp = await world.packs.public("@acme/gcp");
    const aws = await world.packs.public("@acme/aws");

    // Last week: eight public repositories declare gcp, two of them pinned to 1.0.0.
    for (let i = 1; i <= 8; i++) {
      g.publicRepo(`org${i}/app`, { declares: [i <= 2 ? { pack: gcp, version: "1.0.0" } : gcp], createdAt: `202${i % 5}-03-01` });
    }
    g.publicRepo("org10/hidden", { declares: [gcp], private: true });
    g.codeSearch.leakPrivateRepositories();

    const first = await g.scan.run();
    expect(first.outcome).toBe("completed");
    expect(await g.scan.adoption(gcp)).toMatchObject({ declaringRepositories: 8, pinnedVersions: { "1.0.0": 2 }, unpinned: 6, dropped: 0, label: "approximate, weekly" });
    expect(await g.scan.adoption(aws)).toMatchObject({ declaringRepositories: 0 });

    // The queries were split by pack id and by repository creation date, and every one used the read-only public token.
    const queries = g.codeSearch.queries().map((q) => world.unalias(q));
    for (const pack of ["@acme/gcp", "@acme/aws"]) expect(queries.some((q) => q.startsWith(`"${pack}"`))).toBe(true);
    expect(queries.every((q) => /created:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/.test(q))).toBe(true);
    expect(g.codeSearch.credentials()).toEqual(["code-search"]);
    expect(g.codeSearch.privateRepositoryRequests()).toEqual([]);

    // The scan is weekly: asked again at once it does nothing, and it never created a scan to resume.
    expect((await g.scan.run()).outcome).toBe("idle");
    expect(await g.scan.cursor()).toBeNull();

    // This week one fewer repository declares gcp. GitHub answers slowly, past the run's 10 minutes.
    await world.clock.advance("7d");
    g.publicRepo("org8/app", { declares: [] });
    g.codeSearch.slowBy("11m");
    const slow = await g.scan.run();
    expect(slow.outcome).toBe("deadline");
    const saved = await g.scan.cursor();
    expect(saved).not.toBeNull();
    expect(await g.scan.adoption(gcp)).toMatchObject({ declaringRepositories: 8 });
    const searched = g.codeSearch.queries().length;

    // The next run resumes from the cursor: it searches only what is left, and completes.
    g.codeSearch.slowBy(null);
    const resumed = await g.scan.run();
    expect(resumed.outcome).toBe("completed");
    expect(g.codeSearch.queries().slice(searched).every((q) => !g.codeSearch.queries().slice(0, searched).includes(q))).toBe(true);
    expect(await g.scan.cursor()).toBeNull();
    expect(await g.scan.completed()).toBe(2);

    // The count, the pins and the dropped declaration are what the page, ranking and Trending read.
    expect(await g.scan.adoption(gcp)).toMatchObject({ declaringRepositories: 7, pinnedVersions: { "1.0.0": 2 }, unpinned: 5, dropped: 1, label: "approximate, weekly" });

    // The owner of a repository the scan found declaring the pack is a verified adopter; one whose declaration was dropped is not.
    expect(await g.scan.verifiedAdopter("org1", gcp)).toBe(true);
    expect(await g.scan.verifiedAdopter("org8", gcp)).toBe(false);
    expect(await g.scan.verifiedAdopter("org1", aws)).toBe(false);

    // A private repository was never read, whatever the search handed back; nothing was written to GitHub.
    expect(g.codeSearch.privateRepositoryRequests()).toEqual([]);
    expect(g.codeSearch.credentials()).toEqual(["code-search"]);
    expect(await g.writes()).toEqual([]);
  },
  SCAN,
);
