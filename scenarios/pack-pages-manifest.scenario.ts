import { expect, hostileReadme, NotFound, scenario, type PackPageView, type ScenarioOpts, type World } from "@packserver/test-world";

const storage: ScenarioOpts = { needs: ["storage", "fakes"] };
// A scan reads the whole catalogue, so it starts from an empty one.
const scanning: ScenarioOpts = { needs: ["storage", "fakes", "clock", "reset"] };

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
  // Not asserted here: the private page, which waits on private reads.
  const pack = await gcp(world);
  const upload = await world.packs.public("@kite/upload");
  await world.search.list(upload, { pitch: "Uploaded by hand", category: "other", parts: ["skills"] });
  const held = await world.packs.public("@acme/held", { versions: ["1.0.0", "1.1.0"] });
  await world.search.list(held, { pitch: "Held for review", category: "other", parts: ["skills"], repository: "github.com/acme/held" });
  for (let i = 1; i <= 7; i++) world.github.publicRepo(`org${i}/app`, { declares: [pack] });
  expect((await world.github.scan.run()).outcome).toBe("completed");
  const reporter = await world.users.create();
  await reporter.signIn();

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

  expect(live.text).toContain("7 repositories (approximate, weekly)");
  expect(live.trust).toContain(await pack.version("1.1.0").uploadSha256());

  const noRepo = await read(upload.page());
  expect(noRepo.text).toContain("No public repo");
  expect(noRepo.links.some((l) => l.text.startsWith("github.com"))).toBe(false);

  const before = await read(held.page());
  await held.version("1.1.0").seed({ status: "quarantined", reason: "downloads held for review" });
  const report = await world.reports.file(reporter, held, { kind: "security", version: "1.1.0", title: "Token leaks to logs" });
  await world.reports.registrySecurity.publishAdvisory(report, { summary: "A token could reach logs.", versions: ["1.1.0"] });
  const quarantined = await read(held.page());
  expect(quarantined.statusLines).toEqual(["Quarantined: downloads held for review Advisory ›"]);
  expect(quarantined.links.find((l) => l.text === "Advisory ›")?.href).toMatch(/\/versions#advisory-/);
  // Nothing else changes: the page describes the newest version that can still be adopted.
  expect(quarantined.manifest).not.toBeNull();
  expect(quarantined.adopt).toEqual(before.adopt);
  expect(quarantined.text).toContain("1.0.0 · published");
}, scanning);

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

scenario("IT-PAGE-005 The dashboard shows per-pack status and the Needs-you queue", async (world) => {
  const pat = await world.publishers.create({ handle: "pat", mfa: "passkey" });
  const fresh = await world.publishers.create({ handle: "fresh" });
  const reporter = await world.users.create();
  const acme = await pat.orgs.create("acme");

  // The pending application and the proof that is five days from lapsing come first: they need the clock to move.
  const challenge = await acme.verifyDomain("acme.com");
  challenge.publishTxt();
  await acme.checkDomain(challenge);
  await acme.requireMfa("mfa");
  await acme.applyVerified();
  world.dns.remove("acme.com");
  await world.clock.advance("30d");
  await world.cron.run("domain-rechecks");
  await world.clock.advance("25d");
  await pat.signIn();
  await reporter.signIn();

  const live = await world.packs.public("@acme/live", { versions: ["1.0.0"] });
  await world.search.list(live, { pitch: "Live", category: "other", parts: ["skills"] });
  await world.search.signals(live, { stars: 3, fetches: 120 });
  await world.reports.file(reporter, live, { kind: "bug", title: "Crashes on start" });
  const reported = await world.packs.public("@acme/reported", { versions: ["1.0.0"] });
  await world.search.list(reported, { pitch: "Reported", category: "other", parts: ["skills"] });
  await world.reports.file(reporter, reported, { kind: "security", title: "Token leaks to logs" });

  const release = async (name: string, version: string, archive: ReturnType<World["archive"]>) => {
    const admitted = await pat.publish(archive).as(`@acme/${name}@${version}`);
    await world.validation.completes(admitted);
    return admitted;
  };
  const note = (text: string) => ({ "RULES.md": `# Rules\n\n${text}\n` });
  await (await release("waiting", "1.0.0", world.archive("gcp", { files: note("one") }))).promoted();
  const widening = await release("waiting", "1.1.0", world.archive("gcp", { files: { ...note("one"), "env-setup.sh": "#!/bin/sh\nmkdir -p .cache\n" } }));
  expect(await widening.approval()).toMatchObject({ state: "awaiting" });
  const bad = await release("bad", "1.0.0", world.archive("with-secret"));
  expect(await bad.run.verdict()).toBe("fail");
  await world.pauseValidation();
  const busy = await pat.publish(world.archive("gcp")).as("@acme/busy@1.0.0");

  const view = await world.dashboard.of(pat);
  const row = (pack: { systemName: string }) => view.packs.find((p) => p.name === pack.systemName)?.text ?? "";
  expect(row(live)).toContain("1.0.0");
  expect(row(live)).toContain("3 stars · 120 fetches · 1 open issue");
  expect(row(live)).toMatch(/Live$/);
  expect(row(busy.pack)).toMatch(/Working$/);
  expect(row(widening.pack)).toMatch(/Needs you$/);
  expect(row(bad.pack)).toMatch(/Needs you$/);
  expect(row(reported)).toMatch(/Needs you$/);

  expect(view.needs).toEqual(["approval", "failed", "proof", "security", "application"]);
  expect(view.text).toContain("5 things need you.");
  expect(view.text).toContain("lapses in 5 days");
  expect(view.text).not.toMatch(/pay|price|billing|subscription/i);

  await fresh.signIn();
  const empty = await world.dashboard.of(fresh);
  expect(empty.text).toContain("New pack");
  expect(empty.packs).toEqual([]);
  expect(empty.needs).toEqual([]);
  expect(empty.text).not.toMatch(/Needs you|Drafts|Nothing needs you/);
}, { needs: ["fakes", "clock", "storage", "reset"] });

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
  await pack.seedWarnings("1.0.0", { byCategory: { license: 1, docs: 1 }, validationRun: "run-warned" });

  const view = await read(pack.page());
  expect(view.trust).toContain("License 1");
  expect(view.trust).toContain("Docs 1");
  expect(view.text.replace(view.trust, "")).not.toMatch(/warning/i);
  expect(view.links.find((l) => l.text === "Full report")?.href).toMatch(/run-warned$/);

  // A version that only warned is promoted, with its warnings counted by category beside its files.
  const publisher = await world.publishers.create({ handle: "pat" });
  const admitted = await publisher.publish(world.archive("gcp", { version: "1.0.0" })).as("@pat/gcp@1.0.0");
  const run = await world.validation.completes(admitted);
  expect(await run.verdict()).toBe("warn");
  const published = await (await admitted.promoted()).published();
  expect(await admitted.status()).toBe("active");
  expect(published.meta).toMatchObject({ warnings: { license: 1 }, validation_run: run.id });
  expect(published.contents.files.map((f) => f.path)).toContain("README.md");
  expect(published.contents.readme).not.toBeNull();
}, storage);
