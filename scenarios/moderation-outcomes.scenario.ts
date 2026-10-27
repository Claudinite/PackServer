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
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
async function verifiedOwner(world: World, home: string) {
  const pack = await world.packs.public(home, { versions: ["1.0.0"] });
  const owner = await adopter(world, undefined, "3d");
  await world.reports.seedRole(pack, owner, "owner");
  await pack.seedProof({ verified: true, verifiedDomain: `${scopeOf(pack).name}.test` });
  await (await world.admins.create()).applications.grant(scopeOf(pack));
  return owner;
}

/** The owner of a scope with a GitHub-org proof and no Verified Publisher grant, on an account too young to count. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- helper kept verbatim from the file this was split from: the scenario gate fingerprints the code around each scenario
async function proofOnlyOwner(world: World, home: string) {
  const pack = await world.packs.public(home, { versions: ["1.0.0"] });
  const owner = await adopter(world, undefined, "3d");
  await world.reports.seedRole(pack, owner, "owner");
  await pack.seedProof({ verified: false, verifiedGithubOrg: scopeOf(pack).name });
  return owner;
}

/** Runs a change and returns the pack's entry in the scope index once that is signed again, which is when readers of the index see it. */
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

scenario("IT-MOD-014 Actioned publishers are notified and can appeal", async (world) => {
  await world.access.seedRegistryKeys();
  const admin = await world.admins.create();
  const { pack: a, owner: ownerA } = await packWith(world, "@acme/alpha", { versions: ["1.0.0"] });
  const { pack: b, owner: ownerB } = await packWith(world, "@globex/beta", { versions: ["1.0.0", "1.1.0"] });
  const reporter = await person(world);
  const notices = (who: Parameters<World["mail"]["inbox"]>[0]) => world.mail.inbox(who).all().filter((m) => m.subject.startsWith("Action taken") || m.subject.includes("appeal"));

  await admin.moderation.quarantinePack(a, "The install step fetches an unknown host.");
  const filed = await world.reportAbuse(reporter, b, { category: "spam", details: "Advertising in the description.", version: "1.1.0" });
  await admin.moderation.act(filed as { id: string }, { action: "yank", reason: "Advertising, not a pack." });
  expect(await a.version("1.0.0").status()).toBe("quarantined");
  expect(await b.version("1.1.0").status()).toBe("yanked");

  const [noticeA] = notices(ownerA);
  expect(noticeA?.text).toContain("The install step fetches an unknown host.");
  expect(noticeA?.text).toContain(await world.moderation.appealLink(a.version("1.0.0")));
  const [noticeB] = notices(ownerB);
  expect(noticeB?.text).toContain("Advertising, not a pack.");
  expect(noticeB?.text).toContain(await world.moderation.appealLink(b.version("1.1.0")));

  // The first appeal is upheld and the version comes back.
  expect(await world.moderation.appeal(ownerA, a.version("1.0.0"), "The host is our own CDN.")).toBe(true);
  const open = async () => (await admin.moderation.appeals.list()).filter((x) => [a.name, b.name].includes(x.pack));
  expect((await open()).map((x) => [x.pack, x.version, x.note])).toEqual([[a.name, "1.0.0", "The host is our own CDN."]]);
  expect((await admin.queue.list()).filter((e) => e.kind === "moderation-appeal").map((e) => e.pack)).toContain(a.name);
  await admin.moderation.appeals.uphold(a.version("1.0.0"));
  expect(await a.version("1.0.0").status()).toBe("active");
  expect(notices(ownerA).map((m) => m.subject)).toContain(`Your appeal for ${a.systemName}@1.0.0 was upheld`);

  // The second is denied, which is final.
  expect(await world.moderation.appeal(ownerB, b.version("1.1.0"), "It is a description, not an advert.")).toBe(true);
  await admin.moderation.appeals.deny(b.version("1.1.0"));
  expect(await b.version("1.1.0").status()).toBe("yanked");
  expect(notices(ownerB).map((m) => m.text).join("\n")).toContain("This decision is final.");
  expect(await world.moderation.appeal(ownerB, b.version("1.1.0"), "Please look again.")).toBeRefusedSaying("final");
  expect(await open()).toEqual([]);
  // Contrast: someone with no role in the scope cannot see or appeal the action.
  expect(await world.moderation.appeal(reporter, a.version("1.0.0"), "Not mine.")).toBeNotFound();
}, NEEDS);

scenario("IT-MOD-015 Reporters learn the outcome, not the details", async (world) => {
  await world.access.seedRegistryKeys();
  const admin = await world.admins.create();
  const { pack, owner } = await packWith(world, "@acme/gcp", { versions: ["1.0.0", "1.1.0"] });
  const reporter = await person(world);
  const bystander = await person(world);
  const reason = "Contains a keylogger in the setup step.";
  const outcomes = (who: Parameters<World["mail"]["inbox"]>[0]) => world.mail.inbox(who).all().filter((m) => m.subject.startsWith("Update on your report"));

  const filed = (await world.reportAbuse(reporter, pack, { category: "malware", details: "Records keystrokes.", version: "1.0.0" })) as { id: string };
  await world.reportAbuse(bystander, pack, { category: "malware", details: "It watches the keyboard.", version: "1.0.0" });
  await admin.moderation.act(filed, { action: "yank", reason });
  expect(await world.moderation.appeal(owner, pack.version("1.0.0"), "APPEAL-TEXT-FROM-THE-PUBLISHER")).toBe(true);

  for (const who of [reporter, bystander]) {
    const [notice] = outcomes(who);
    expect(outcomes(who)).toHaveLength(1);
    expect(notice?.text).toContain("was acted on");
    for (const hidden of [reason, admin.email, "APPEAL-TEXT-FROM-THE-PUBLISHER", "keylogger"]) expect(`${notice?.subject}\n${notice?.text}`).not.toContain(hidden);
  }

  // Contrast: a dismissed report is told the report was closed.
  const second = (await world.reportAbuse(reporter, pack, { category: "spam", details: "Odd wording.", version: "1.1.0" })) as { id: string };
  await admin.moderation.dismiss(second);
  expect(outcomes(reporter).map((m) => m.text).join("\n")).toContain("closed without action");
}, NEEDS);

scenario("IT-MOD-016 Moderation yanks carry the Removed by PackServer prefix", async (world) => {
  await world.access.seedRegistryKeys();
  const admin = await world.admins.create();
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0", "1.1.0"] });
  await world.search.list(pack, LISTED);
  const reporter = await person(world);

  const filed = (await world.reportAbuse(reporter, pack, { category: "malware", details: "Steals tokens.", version: "1.0.0" })) as { id: string };
  const entry = await indexed(world, pack, () => admin.moderation.act(filed, { action: "yank", reason: "malware" }));

  expect(entry.latest_eligible).toBe("1.1.0");
  expect(await pack.version("1.0.0").status()).toBe("yanked");
  expect(await world.moderation.reason(pack.version("1.0.0"))).toBe("Removed by PackServer: malware");
  expect((await admin.audit()).filter((e) => e.target?.includes(pack.name)).map((e) => e.verb)).toContain("version.yank");
}, NEEDS);

scenario("IT-ABUSE-006 Report spammers can be flagged and blocked", async (world) => {
  const admin = await world.admins.create();
  const { pack, maintainer } = await packWith(world, "@acme/gcp");
  const spammer = await person(world);
  const other = await person(world);
  const first = await world.reports.file(spammer, pack, { kind: "bug", title: "Bug 0" });
  await world.moderation.seed.reportsFiled(spammer, pack, 11);

  const spammerId = (await spammer.account.show()).id;
  const flagsOnSpammer = async () => (await admin.moderation.flags()).filter((f) => f.id === spammerId);
  expect(await flagsOnSpammer()).toEqual([]);
  expect(await world.moderation.flagReporter(other, pack, first)).toBeRefusedSaying("maintainers");
  expect(await world.moderation.flagReporter(maintainer, pack, first)).toBe(true);
  expect(await flagsOnSpammer()).toMatchObject([{ flaggedBy: 1, filed: 12, blocked: false }]);

  await admin.moderation.block({ id: spammerId });
  expect(await flagsOnSpammer()).toMatchObject([{ blocked: true }]);
  await expect(world.reports.file(spammer, pack, { kind: "bug", title: "Bug 13" })).toBeRefusedSaying("no longer");
  await expect(world.reportAbuse(spammer, pack, { category: "spam", details: "More noise." })).toBeRefusedSaying("no longer");
  // Contrast: everyone else still reports.
  expect(await world.reports.file(other, pack, { kind: "bug", title: "A real bug" })).toMatchObject({ id: expect.any(String) });
  expect((await admin.audit()).map((x) => x.verb)).toContain("reporter.block");
}, NEEDS);

scenario("IT-MOD-018 A DMCA counter-notice restores after the statutory window", async (world) => {
  await world.access.seedRegistryKeys();
  const admin = await world.admins.create();
  const { pack, owner } = await packWith(world, "@acme/lib", { versions: ["1.0.0", "1.1.0"] });
  const complainant = { email: "rights@claimant.test" };
  const first = pack.version("1.0.0");
  const second = pack.version("1.1.0");

  await admin.moderation.dmca.remove(first, complainant.email);
  await admin.moderation.dmca.remove(second, complainant.email);
  expect(await first.status()).toBe("quarantined");
  expect(world.mail.inbox(owner).all().map((m) => m.text).join("\n")).toContain("Removed by PackServer: copyright notice");
  // A copyright removal is answered by a counter-notice, not an appeal.
  expect(await world.moderation.appeal(owner, first, "This is mine.")).toBeRefusedSaying("counter-notice");

  const words = "I wrote this code and license it under MIT.";
  expect(await world.moderation.counterNotice(owner, first, words)).toBe(true);
  expect(await world.moderation.counterNotice(owner, second, words)).toBe(true);
  expect(await world.moderation.counterNotice(owner, first, words)).toBeRefusedSaying("already");
  expect(world.mail.inbox(complainant).all().filter((m) => m.subject.startsWith("Counter-notice for"))).toHaveLength(2);
  expect(world.mail.inbox(complainant).latest().text).toContain(words);

  await world.moderation.dmca.advanceBusinessDays(9);
  expect(await world.moderation.dmca.sweep()).toEqual({ restored: 0 });
  expect(await first.status()).toBe("quarantined");

  // The complainant tells the registry about a suit for the second version.
  await world.moderation.dmca.advanceBusinessDays(2);
  await admin.moderation.dmca.suit(second);

  await world.moderation.dmca.advanceBusinessDays(3);
  expect(await world.moderation.dmca.sweep()).toEqual({ restored: 1 });
  expect(await first.status()).toBe("active");
  expect(await second.status()).toBe("quarantined");
  expect(await world.moderation.dmca.sweep()).toEqual({ restored: 0 });

  const verbs = async (version: typeof first) => (await world.moderation.audit(version)).map((x) => x.verb).filter((v) => v.startsWith("dmca")).sort();
  expect(await verbs(first)).toEqual(["dmca.counter_notice", "dmca.remove", "dmca.restore"]);
  expect(await verbs(second)).toEqual(["dmca.counter_notice", "dmca.remove", "dmca.suit"]);
}, NEEDS);

scenario("JT-004 Abuse report labels, the judge's timer quarantines, moderation, appeal and restoration (registry half)", async (world) => {
  await world.access.seedRegistryKeys();
  const admin = await world.admins.create();
  const agent = world.agents.anonymous();
  const { pack, owner } = await packWith(world, "@acme/gcp", { versions: ["1.0.0"] });
  await world.search.list(pack, LISTED);
  await world.admins.declaredBy(pack, 12);
  const reporter = await adopter(world, undefined, "40d");
  const version = pack.version("1.0.0");

  const clicked = await world.clickReportAbuse(pack);
  expect(clicked.headers.location).toContain("/signin");
  const filed = (await world.reportAbuse(reporter, pack, { category: "malware", details: "The setup step runs a downloaded binary." })) as { id: string };
  expect(await labelled(world, pack)).toBe(true);
  const queue = await admin.queue.list();
  const place = queue.findIndex((e) => e.id === filed.id);
  expect(queue[place]).toMatchObject({ kind: "abuse-report", priority: true });
  expect(queue.slice(0, place).every((e) => e.priority === true)).toBe(true);
  expect((await agent.download(pack, "1.0.0")).body).toHaveProperty("url");

  await world.clock.advance("61m");
  const held = await indexed(world, pack, async () => expect(await world.moderation.judge.fireTimer(pack)).toEqual([`${pack.name}@1.0.0`]));
  expect(held.latest_eligible).toBeNull();
  const refused = (await agent.download(pack, "1.0.0")).body;
  expect(refused).toMatchObject({ under_review: true });
  expect(refused).not.toHaveProperty("url");

  await admin.moderation.act(filed, { action: "yank", reason: "malware" });
  expect(await version.status()).toBe("yanked");
  expect(await world.moderation.reason(version)).toBe("Removed by PackServer: malware");
  expect((await world.moderation.audit(version)).map((x) => [x.verb, x.actor])).toContainEqual(["version.yank", admin.email]);

  const [hold, yank] = world.mail.inbox(owner).all().filter((m) => m.subject.startsWith("Action taken"));
  expect(hold?.text).toContain("security report undecided for an hour");
  expect(yank?.text).toContain("Removed by PackServer: malware");
  expect(yank?.text).toContain(await world.moderation.appealLink(version));
  const reporterNotice = world.mail.inbox(reporter).all().find((m) => m.subject.startsWith("Update on your report"));
  expect(reporterNotice?.text).toContain("was acted on");
  expect(reporterNotice?.text).not.toContain("malware");

  expect(await world.moderation.appeal(owner, version, "The binary is our own signed helper.")).toBe(true);
  await admin.moderation.appeals.uphold(version);
  expect(await version.status()).toBe("active");
  expect((await agent.download(pack, "1.0.0")).body).toHaveProperty("url");
}, NEEDS);
