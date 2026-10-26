import { expect, hostileReadme, NotFound, scenario, type PackPageView, type ScenarioOpts, type World } from "@packserver/test-world";

const storage: ScenarioOpts = { needs: ["storage", "fakes"] };

async function read(page: Promise<PackPageView | NotFound>): Promise<PackPageView> {
  const view = await page;
  if (view instanceof NotFound) throw new Error("the page was not found");
  return view;
}

const guard = { guards: [{ name: "no-secrets", tool_calls: ["Bash"] }] };

// The skills and guard of IT-PAGE-001's first pack.
async function gcp(world: World) {
  const pack = await world.packs.public("@acme/gcp", {
    versions: ["1.0.0", "1.1.0"],
    verification: { verified: true, verifiedDomain: "acme.com" },
    capabilities: ["guard"],
    preinstall: guard,
    inventory: { skills: 2, guards: 1 },
  });
  await world.search.list(pack, { pitch: "Deploys things to GCP", category: "cloud", parts: ["skills", "guards"], repository: "github.com/acme/gcp", score: 80 });
  await world.search.signals(pack, { stars: 3, rating: 4.2, fetches: 120 });
  await pack.seedContents("1.1.0", { readme: "# GCP\n\nDeploys things.\n", files: [{ path: "README.md", text: "# GCP\n" }] });
  return pack;
}

scenario("IT-PAGE-001 The pack page leads with four things and keeps the rest one gesture away", async (world) => {
  // Not asserted here: the approximate declaring count waits on the weekly scan, the private page on private reads, and the advisory link on advisories.
  const pack = await gcp(world);
  const upload = await world.packs.public("@kite/upload");
  await world.search.list(upload, { pitch: "Uploaded by hand", category: "other", parts: ["skills"] });
  const held = await world.packs.public("@acme/held", { versions: ["1.0.0", "1.1.0"] });
  await world.search.list(held, { pitch: "Held for review", category: "other", parts: ["skills"], repository: "github.com/acme/held" });
  await held.version("1.1.0").seed({ status: "quarantined", reason: "downloads held for review" });

  await world.agents.setAdoptVersion(null);
  const preview = await read(pack.page());
  expect(preview.text).toContain("Deploys things to GCP");
  expect(preview.text).toContain("acme.com");
  expect(preview.text).not.toContain("Verified Publisher");
  expect(preview.manifest).toContain("Adds 1 guard");
  expect(preview.adopt).toEqual([expect.stringMatching(/^Preview: adoptable with cn ≥ \S+/)]);
  expect(preview.text).not.toContain("packs.declared");

  await world.agents.setAdoptVersion("1.62000.0");
  const live = await read(pack.page());
  expect(live.adopt).toEqual([`cn adopt ${pack.name}`, `packs.declared: ["${pack.name}"]`]);

  const created = (await pack.version("1.1.0").detail()).published_at as string;
  expect(live.text).toContain(`1.1.0 · published ${created.slice(0, 10)}`);
  expect(live.links.some((l) => l.text === "github.com/acme/gcp")).toBe(true);
  for (const shown of ["Score 80 of 100", "4.2", "about 120 fetches in 30 days", "2 skills · 1 guard", await pack.version("1.1.0").canonicalSha256()]) {
    expect(live.text).toContain(shown);
  }
  expect(live.statusLines).toEqual([]);
  expect(live.text).not.toMatch(/visibility/i);

  const noRepo = await read(upload.page());
  expect(noRepo.text).toContain("No public repo");
  expect(noRepo.links.some((l) => l.text.startsWith("github.com"))).toBe(false);

  const quarantined = await read(held.page());
  expect(quarantined.statusLines).toEqual(["1.1.0 is quarantined, under review: downloads held for review"]);
  expect(quarantined.text).toContain("Held for review");
}, storage);

scenario("IT-PAGE-003 Every file of a public pack is readable on the site", async (world) => {
  const pack = await world.packs.public("@acme/gcp");
  await world.search.list(pack, { pitch: "Everything", category: "cloud", parts: ["rules", "skills", "checks", "tasks"] });
  const files = [
    { path: "RULES.md", text: "# Rules\nBe careful.\n## Secrets\nNever print them.\n" },
    { path: "skills/deploy/SKILL.md", text: "# Deploy\nShip it.\n" },
    { path: "skills/logs/SKILL.md", text: "# Logs\nRead them.\n" },
    { path: "declared-checks.json", text: '{"checks":[]}\n' },
    { path: "checks/lint.go", text: "package checks\n" },
    { path: "tasks/nightly.json", text: '{"cadence":"daily"}\n' },
    { path: "guards/with-html.html", text: "<script>alert(1)</script>\n" },
    { path: "guards/with-html.svg", text: '<svg onload="alert(1)"></svg>\n' },
  ];
  await pack.seedContents("1.0.0", { readme: "# Everything\n", files });

  const tab = await read(pack.page("contents"));
  expect(tab.files).toEqual([
    { path: "RULES.md", part: "rules" },
    { path: "skills/deploy/SKILL.md", part: "skills" },
    { path: "skills/logs/SKILL.md", part: "skills" },
    { path: "checks/lint.go", part: "checks" },
    { path: "declared-checks.json", part: "checks" },
    { path: "guards/with-html.html", part: "guards" },
    { path: "guards/with-html.svg", part: "guards" },
    { path: "tasks/nightly.json", part: "tasks" },
  ]);
  for (const file of files) expect(tab.fileText(file.path)).toBe(file.text);
  expect(tab.anchors.filter((a) => a.includes("RULES.md"))).toHaveLength(2);
  expect(new Set(tab.anchors).size).toBe(tab.anchors.length);
}, storage);

scenario("IT-PAGE-004 Rendered READMEs are sanitised with nofollow ugc links", async (world) => {
  const pack = await world.packs.public("@acme/gcp");
  await world.search.list(pack, { pitch: "Readme", category: "cloud", parts: ["rules"] });
  await pack.seedContents("1.0.0", { readme: hostileReadme, files: [] });

  const view = await read(pack.page());
  expect(view.readmeHtml).not.toBeNull();
  expect(view.readmeHtml).not.toMatch(/<script|onclick|<iframe|javascript:/i);
  expect(view.links.find((l) => l.text === "docs")).toMatchObject({ rel: "nofollow ugc" });
}, storage);

scenario("IT-SCORE-005 No public repo carries a marker", async (world) => {
  // The browse page's marker belongs to the site pages; the search card carries the fact it is drawn from.
  const pack = await world.packs.public("@kite/upload");
  await world.search.list(pack, { pitch: "Uploaded by hand", category: "other", parts: ["skills"] });

  expect((await read(pack.page())).text).toContain("No public repo");
  expect((await world.search.site("Uploaded")).cards.find((c) => c.id === pack.name)).toMatchObject({ repository: null });
}, storage);

scenario("IT-SCORE-007 The page shows score and largest improvement; MCP returns the parts", async (world) => {
  const parts = [
    {
      part: "context_cost",
      weight: 20,
      points: 9,
      rules: [
        { rule: "context-cost.always-loaded", points: 4, max: 13 },
        { rule: "context-cost.skill-body-lines", points: 5, max: 6 },
      ],
    },
    { part: "checks", weight: 20, points: 20, rules: [{ rule: "checks.declared", points: 20, max: 20 }] },
  ];
  const pack = await world.packs.public("@acme/gcp", { score: { total: 64, parts } });
  await world.search.list(pack, { pitch: "Scored", category: "cloud", parts: ["rules"], score: 64 });

  const view = await read(pack.page());
  expect(view.text).toContain("Score 64 of 100");
  expect(view.text).toContain("+9 Shorten RULES.md and the skill descriptions");
  expect(view.text).toContain("Context cost · 9/20");

  expect((await world.search.site("Scored")).cards.find((c) => c.id === pack.name)).toMatchObject({ score: 64 });
  const agent = (await world.agents.anonymous().pack(pack)).body;
  expect(agent.score).toMatchObject({ total: 64, parts });
}, storage);

scenario("IT-VAL-015 Warnings do not block; the full report is public once published", async (world) => {
  // The report's own page and the unpublished run's access wait on the validation page; this is the pack page's half.
  const pack = await world.packs.public("@acme/gcp");
  await world.search.list(pack, { pitch: "Warned", category: "cloud", parts: ["rules"] });
  await pack.seedReport("1.0.0", { runId: "run-warned", warnings: ["license.missing", "docs.readme-missing"] });

  const view = await read(pack.page());
  expect(view.trust).toContain("License 1");
  expect(view.trust).toContain("Docs 1");
  expect(view.text.replace(view.trust, "")).not.toMatch(/warning/i);
  expect(view.links.find((l) => l.text === "Full report")?.href).toMatch(/run-warned$/);
}, storage);
