import { expect, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage"] };

/** A signed-in person with the system's own name for them. */
async function person(world: World, age = "3d") {
  const who = await world.users.create();
  await who.signIn();
  await world.community.setAge(who, age);
  return who;
}

/** A public pack whose scope the given person owns, and a maintainer who publishes. */
async function packWith(world: World, name: string, opts: { versions?: string[] } = {}) {
  const pack = await world.packs.public(name, { versions: opts.versions ?? ["1.0.0", "1.0.1", "1.0.2"] });
  const owner = await person(world);
  const maintainer = await person(world);
  await world.reports.seedRole(pack, owner, "owner");
  await world.reports.seedRole(pack, maintainer, "maintainer");
  return { pack, owner, maintainer };
}

const LISTED = { pitch: "Format markdown tables", category: "backend" } as const;
const REPORTED = "Reported, under review";

/** A listed pack with one version whose public scan found `declared` repositories declaring it. */
async function reportedPack(world: World, name: string, declared: number) {
  const pack = await world.packs.public(name, { versions: ["1.0.0"] });
  await world.search.list(pack, LISTED);
  await world.admins.declaredBy(pack, declared);
  return pack;
}

/** A signed-in person whose account is `age` old and who downloaded the pack signed in. */
async function adopter(world: World, pack: Parameters<World["community"]["download"]>[1] | undefined, age = "31d") {
  const who = await person(world);
  await world.community.setAge(who, age);
  if (pack) await world.community.download(who, pack);
  return who;
}

/** The scope name of a seeded pack. */
const scopeOf = (pack: { name: string }) => ({ name: pack.name.slice(1).split("/")[0] as string });

/** The owner of a scope that holds Verified Publisher: an account of any age. */
async function verifiedOwner(world: World, home: string) {
  const pack = await world.packs.public(home, { versions: ["1.0.0"] });
  const owner = await adopter(world, undefined, "3d");
  await world.reports.seedRole(pack, owner, "owner");
  await pack.seedProof({ verified: true, verifiedDomain: `${scopeOf(pack).name}.test` });
  await (await world.admins.create()).applications.grant(scopeOf(pack));
  return owner;
}

/** The owner of a scope with a GitHub-org proof and no Verified Publisher grant, on an account too young to count. */
async function proofOnlyOwner(world: World, home: string) {
  const pack = await world.packs.public(home, { versions: ["1.0.0"] });
  const owner = await adopter(world, undefined, "3d");
  await world.reports.seedRole(pack, owner, "owner");
  await pack.seedProof({ verified: false, verifiedGithubOrg: scopeOf(pack).name });
  return owner;
}

/** Runs a change and returns the pack's entry in the scope index once that is signed again, which is when readers of the index see it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
async function indexed(world: World, pack: Parameters<World["search"]["list"]>[0], change: () => Promise<unknown>) {
  const before = await world.registry.serial(pack);
  await change();
  const { scope } = await world.registry.indexes(pack, { newerThan: before });
  const entry = scope.document.packs.find((p) => p.name === pack.systemName);
  if (!entry) throw new Error(`${pack.name} is not in its scope index`);
  return entry;
}

async function labelled(world: World, pack: Parameters<World["search"]["list"]>[0]) {
  const view = (await pack.page()) as { statusLines: string[] };
  const listed = (await world.agents.anonymous().pack(pack)).body.status_label;
  return view.statusLines.includes(REPORTED) && listed === REPORTED;
}

scenario("IT-MOD-008 Report abuse with a category; anonymous visitors sign in first", async (world) => {
  const { pack } = await packWith(world, "@acme/gcp");
  const reporter = await person(world);
  const author = await adopter(world, undefined, "3d");
  const review = (await world.community.review(author, pack, { rating: 1, body: "Do not use." })) as { id: string };
  const owner = await world.publishers.create({ handle: "own", mfa: "passkey" });
  await owner.signIn();
  const org = await owner.orgs.create("acme-co");
  const admin = await world.admins.create();

  const spam = await world.reportAbuse(reporter, pack, { category: "spam", details: "Keyword stuffing in the description." });
  const fake = await world.reportAbuse(reporter, { review }, { category: "impersonation", details: "Pretends to be the maintainer." });
  const other = await world.reportAbuse(reporter, { profile: org }, { category: "other", details: "Something else is wrong here." });
  expect([spam, fake, other]).toMatchObject([{ category: "spam" }, { category: "impersonation" }, { category: "other" }]);
  const queued = (await admin.moderation.abuse()).filter((r) => [spam, fake, other].some((x) => (x as { id: string }).id === r.id));
  expect(queued.map((r) => [r.kind, r.category]).sort()).toEqual([["pack", "spam"], ["profile", "other"], ["review", "impersonation"]]);

  const clicked = await world.clickReportAbuse(pack);
  expect(clicked.headers.location).toBe(`/signin?next=${encodeURIComponent(`/packs/${pack.systemName}/report-abuse`)}`);
  expect((await admin.moderation.abuse()).filter((r) => r.pack === pack.name || r.kind !== "pack")).toHaveLength(queued.length);
  // Contrast: a signed-in person is shown the form.
  const form = await world.clickReportAbuse(pack, reporter);
  expect(form.headers).not.toHaveProperty("location");
  expect(String(form.body)).toContain(pack.systemName);
  // A category outside the list is refused.
  await expect(world.reportAbuse(reporter, pack, { category: "annoying" as never, details: "I do not like it." })).toBeRefusedSaying("category");
  // A failed human check, an account under a day old and the eleventh report of a day are each refused.
  await expect(world.reportAbuse(reporter, pack, { category: "spam", details: "Sent by a script.", humanCheck: "fail" })).toBeRefused("human-check");
  await expect(world.reportAbuse(await person(world, "2h"), pack, { category: "spam", details: "Brand new account." })).toBeRefusedSaying("24 hours");
  const busy = await person(world);
  await world.moderation.seed.filedToday(busy, 9);
  expect(await world.reportAbuse(busy, pack, { category: "other", details: "The tenth concern." })).toMatchObject({ category: "other" });
  await expect(world.reportAbuse(busy, pack, { category: "other", details: "One concern too many." })).toBeRefused("quota");
}, NEEDS);

scenario("IT-MOD-009 A high-severity report labels and jumps the queue; downloads are held only on standing, the judge's timer, or an admin", async (world) => {
  await world.access.seedRegistryKeys();
  const admin = await world.admins.create();
  const agent = world.agents.anonymous();
  const [a, b, c, d, e, f] = [
    await reportedPack(world, "@acme/alpha", 3),
    await reportedPack(world, "@acme/beta", 3),
    await reportedPack(world, "@acme/gamma", 3),
    await reportedPack(world, "@acme/delta", 3),
    await reportedPack(world, "@acme/epsilon", 101),
    await reportedPack(world, "@acme/zeta", 3),
  ] as const;
  const r1 = await verifiedOwner(world, "@northwind/home");
  const r2 = await proofOnlyOwner(world, "@contoso/home");
  const s4 = await adopter(world, undefined);
  const [s1, s2, s3, d1] = [await adopter(world, d), await adopter(world, d), await adopter(world, d), await adopter(world, d)] as const;
  await world.moderation.seed.dismissed(d1, 2);
  const [y1, y2, y3] = [await adopter(world, e, "29d"), await adopter(world, e, "29d"), await adopter(world, e, "29d")] as const;

  // A: one account without standing; the label and the queue place at once, the hold waits for the judge's hour.
  await world.reportAbuse(s4, a, { category: "malware", details: "The setup step downloads and runs a binary." });
  expect(await labelled(world, a)).toBe(true);
  const queue = await admin.queue.list();
  const place = queue.findIndex((x) => x.kind === "abuse-report" && x.pack === a.name);
  expect(queue[place]).toMatchObject({ category: "malware", priority: true });
  expect(queue.slice(0, place).every((x) => x.priority === true)).toBe(true);
  await world.clock.advance("59m");
  expect(await world.moderation.judge.fireTimer(a)).toEqual([]);
  expect(await a.version("1.0.0").status()).toBe("active");
  expect((await agent.download(a, "1.0.0")).body).not.toHaveProperty("under_review");
  await world.clock.advance("2m");
  expect(await world.moderation.judge.fireTimer(a)).toEqual([`${a.name}@1.0.0`]);
  expect(await a.version("1.0.0").status()).toBe("quarantined");
  expect((await agent.download(a, "1.0.0")).body).toMatchObject({ under_review: true });

  // B: a Verified Publisher's single report holds at once.
  await world.reportAbuse(r1, b, { category: "prompt_injection", details: "The rules tell the agent to ignore its instructions." });
  expect(await b.version("1.0.0").status()).toBe("quarantined");

  // C: a GitHub-org proof alone is not standing.
  await world.reportAbuse(r2, c, { category: "malware", details: "Ships an obfuscated installer." });
  expect(await labelled(world, c)).toBe(true);
  expect(await c.version("1.0.0").status()).toBe("active");

  // D: three accounts with standing hold it; one that lost its standing does not count.
  for (const [who, details] of [[s1, "Phones home on install."], [s2, "Reads the SSH keys."], [d1, "Looks like a stealer."]] as const) {
    await world.reportAbuse(who, d, { category: "malware", details });
  }
  expect(await labelled(world, d)).toBe(true);
  expect(await d.version("1.0.0").status()).toBe("active");
  await world.reportAbuse(s3, d, { category: "malware", details: "Exfiltrates environment variables." });
  expect(await d.version("1.0.0").status()).toBe("quarantined");

  // E: declared by more than 100 repositories, so no standing holds it, a Verified Publisher's included, nor the judge's hour.
  for (const [who, details] of [[y1, "Strange network calls."], [y2, "Writes outside the repository."], [y3, "Disables the guard."]] as const) {
    await world.reportAbuse(who, e, { category: "malware", details });
  }
  await world.reportAbuse(r1, e, { category: "malware", details: "Deletes the git history." });
  expect(await labelled(world, e)).toBe(true);
  expect(await e.version("1.0.0").status()).toBe("active");
  await world.clock.advance("2h");
  expect(await world.moderation.judge.fireTimer(e)).toEqual([]);
  expect(await e.version("1.0.0").status()).toBe("active");
  const waiting = (await admin.moderation.abuse()).filter((r) => r.pack === e.name);
  expect(waiting).toHaveLength(4);
  expect(waiting.every((r) => r.priority)).toBe(true);
  await admin.moderation.act(waiting[0] as { id: string }, { action: "quarantine", reason: "Held while moderators read the reports" });
  expect(await e.version("1.0.0").status()).toBe("quarantined");

  // Contrast: accounts one day short of the age that counts label and hold nothing.
  for (const [who, details] of [[y1, "One."], [y2, "Two."], [y3, "Three."]] as const) {
    await world.reportAbuse(who, f, { category: "malware", details });
  }
  expect(await labelled(world, f)).toBe(true);
  expect(await f.version("1.0.0").status()).toBe("active");
}, NEEDS);

scenario("IT-MOD-010 Mass identical reports collapse into one", async (world) => {
  await world.access.seedRegistryKeys();
  const admin = await world.admins.create();
  const pack = await reportedPack(world, "@acme/gcp", 3);
  const words = "Steals tokens on install.";
  await world.moderation.seed.identicalReports(pack, { count: 30, category: "malware", details: words, accountAge: "2d" });

  const ours = async () => (await admin.moderation.abuse()).filter((r) => r.pack === pack.name);
  expect(await ours()).toMatchObject([{ category: "malware", count: 30, priority: true }]);
  expect(await pack.version("1.0.0").status()).toBe("active");

  // Established accounts saying the same words add to the count and to nothing else.
  const [s1, s2, s3] = [await adopter(world, pack), await adopter(world, pack), await adopter(world, pack)] as const;
  for (const who of [s1, s2, s3]) await world.reportAbuse(who, pack, { category: "malware", details: words });
  expect(await ours()).toMatchObject([{ count: 33 }]);
  expect(await pack.version("1.0.0").status()).toBe("active");
  await expect(world.reportAbuse(s1, pack, { category: "malware", details: "  STEALS tokens   on install." })).toBeRefusedSaying("already");

  // Contrast: the same three in their own words are three reports with standing.
  for (const [who, details] of [[s1, "It reads my token file."], [s2, "It posts my token somewhere."], [s3, "It leaks my token."]] as const) {
    await world.reportAbuse(who, pack, { category: "malware", details });
  }
  expect(await pack.version("1.0.0").status()).toBe("quarantined");
}, NEEDS);
