import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts, World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage", "reset"] };
const ENV_SETUP = "#!/bin/sh\nmkdir -p .cache\n";

type Person = Awaited<ReturnType<World["publishers"]["create"]>>;

/** Publishes the next version of `@<handle>/tool` with install-from-URL prose, which the rules hold for review. */
async function held(world: World, publisher: Person, handle: string, version: string, files: Record<string, string> = {}) {
  const readme = `# tool\n\nFirst pip install ${world.link("helper.tar.gz")} and then continue.\n`;
  const admitted = await publisher.publish(world.archive("gcp", { files: { "README.md": readme, ...files } })).as(`@${handle}/tool@${version}`);
  expect(await (await world.validation.completes(admitted)).verdict()).toBe("hold");
  return admitted;
}

/** Publishes the next version of `@<handle>/tool` clean, so it validates without waiting for anyone. */
async function clean(world: World, publisher: Person, handle: string, version: string) {
  const admitted = await publisher.publish(world.archive("gcp")).as(`@${handle}/tool@${version}`);
  expect(["pass", "warn"]).toContain(await (await world.validation.completes(admitted)).verdict());
  return admitted;
}

const without = <T extends object>(profile: T, ...keys: string[]) => Object.fromEntries(Object.entries(profile).filter(([k]) => !keys.includes(k)));

scenario("IT-ADMIN-008 The admin Worker validates the Access assertion itself", async (world) => {
  const refused = ["forged", "wrong-audience", "expired", "outsider", "missing", "workers-dev", "preview-url"] as const;
  for (const how of refused) expect(await world.admins.visit(how), how).toEqual({ found: false });
  expect(await world.admins.visit("valid")).toEqual({ found: true });
}, NEEDS);

scenario("IT-ADMIN-003 Admins approve or reject held versions with the diff and findings (decision half)", async (world) => {
  const admin = await world.admins.create();
  const rev = await world.publishers.create({ handle: "rev" });
  const first = await clean(world, rev, "rev", "1.0.0");
  await world.admins.promoted(first);

  const approved = await held(world, rev, "rev", "1.1.0", { "env/setup.sh": ENV_SETUP });
  const item = await admin.queue.open(approved);
  expect(item.against).toBe("1.0.0");
  expect(item.files.find((f) => f.path === "README.md")).toMatchObject({ change: "modified" });
  expect(item.files.find((f) => f.path === "env/setup.sh")).toMatchObject({ change: "added" });
  expect(item.capabilities).toMatchObject({ added: ["env-setup"], removed: [] });
  expect(item.findings.find((f) => f.rule === "text.url-install")).toMatchObject({ class: "hold", file: "README.md" });
  expect(item.findings.find((f) => f.rule === "text.url-install")?.quote).toContain("pip install");

  await admin.queue.approve(approved);
  expect(await admin.queue.decision(approved)).toMatchObject({ decision: "approve", decidedBy: admin.email });
  expect((await admin.queue.list()).filter((e) => e.kind === "held-version")).toEqual([]);

  const rejected = await held(world, rev, "rev", "1.2.0");
  await admin.queue.reject(rejected, "The helper archive is not one we can let your pack run");
  expect(await admin.queue.decision(rejected)).toMatchObject({ decision: "reject", reason: "The helper archive is not one we can let your pack run" });
  expect(world.mail.inbox(rev).latest().text).toContain("The helper archive is not one we can let your pack run");

  const other = await world.publishers.create({ handle: "oth" });
  const flagged = await held(world, other, "oth", "1.0.0");
  await admin.queue.quarantinePublisher(flagged, "Install from a URL, again");
  expect(await admin.queue.decision(flagged)).toMatchObject({ decision: "quarantine_publisher" });
  await expect(other.publish(world.archive("gcp")).as("@oth/tool@1.0.1")).toBeRefused();
}, NEEDS);

scenario("IT-VAL-013 Held versions queue by standing and never resolve by timeout (queue half)", async (world) => {
  const admin = await world.admins.create();
  const [fresh, modest, popular, vp] = await Promise.all(["fresh", "modest", "popular", "vp"].map((handle) => world.publishers.create({ handle })));
  const oldest = await held(world, fresh!, "fresh", "1.0.0");
  const [fewRepos, manyRepos] = await Promise.all([
    held(world, modest!, "modest", "1.0.0"),
    held(world, popular!, "popular", "1.0.0"),
    held(world, vp!, "vp", "1.0.0"),
  ]);
  await world.admins.proveDomain(vp!.scope, "vp.example");
  await admin.applications.grant(vp!.scope);
  await world.admins.declaredBy(manyRepos.pack, 500);
  await world.admins.declaredBy(fewRepos.pack, 5);

  const order = async () => (await admin.queue.list()).filter((e) => e.kind === "held-version").map((e) => e.pack);
  const expected = ["@vp/tool", "@popular/tool", "@modest/tool", "@fresh/tool"];
  expect(await order()).toEqual(expected);
  expect((await admin.queue.list())[0]).toMatchObject({ standing: { verified: true } });

  await world.clock.advance("30d");
  expect(await order()).toEqual(expected);

  await oldest.abandonInstance();
  await admin.queue.approve(oldest);
  expect(await admin.queue.decision(oldest)).toMatchObject({ decision: "approve" });
  expect(await order()).toEqual(expected.slice(0, 3));
  expect(await oldest.resume()).toMatchObject([{ source: "review", delivered: "instance" }]);
  await oldest.promoted();
}, NEEDS);

scenario("IT-VAL-040 A rejected version can be appealed once; the appeal never reaches a model (admin half)", async (world) => {
  const admin = await world.admins.create();
  const publisher = await world.publishers.create({ handle: "app" });
  const denied = await held(world, publisher, "app", "1.0.0");
  const upheld = await held(world, publisher, "app", "1.0.1");
  for (const version of [denied, upheld]) await admin.queue.reject(version, "Not acceptable as written");
  await expect(denied.appeal("x".repeat(2001), publisher)).toBeRefused();
  await denied.appeal("The helper is a build tool, here is the repository", publisher);
  await upheld.appeal("The URL is documentation, not an install step", publisher);
  await expect(denied.appeal("Once more, please", publisher)).toBeRefused();

  const item = await admin.queue.open(denied);
  expect(item.appeal).toEqual({ note: "The helper is a build tool, here is the repository", state: "open" });
  expect(item.findings.map((f) => f.rule)).toContain("text.url-install");
  expect((await admin.appeals.list()).map((a) => a.version).sort()).toEqual(["1.0.0", "1.0.1"]);

  await admin.appeals.deny(denied);
  await admin.appeals.uphold(upheld);
  expect((await admin.queue.open(denied)).appeal?.state).toBe("denied");
  expect((await admin.queue.open(upheld)).appeal?.state).toBe("upheld");
  await expect(admin.appeals.uphold(denied)).toBeRefusedSaying("already decided");
  await expect(admin.appeals.deny(upheld)).toBeRefusedSaying("already decided");
  expect(await admin.appeals.list()).toEqual([]);
  const before = await world.sandbox.calls();
  await upheld.resume();
  await upheld.promoted();
  expect(await world.sandbox.calls()).toEqual(before);
  expect(await denied.downloadable()).toBe(false);
}, NEEDS);

scenario("IT-ADMIN-006 Admins see full reports and prose-screen results without numbers", async (world) => {
  const admin = await world.admins.create();
  const publisher = await world.publishers.create({ handle: "rep" });
  const published = await clean(world, publisher, "rep", "2.1.0");
  const waiting = await held(world, publisher, "rep", "2.2.0");

  for (const version of [published, waiting]) {
    const report = await admin.reports.full(version);
    expect(report.proseScreen).toMatchObject({ implementation: "static-only", tripped: [] });
    expect(JSON.stringify(report.proseScreen)).not.toMatch(/threshold|probabilit|\b0\.\d+\b/i);
    expect(report.text).not.toMatch(/probabilit/i);
    expect(await admin.reports.proseScreen(version)).toMatchObject({ implementation: "static-only" });
  }
  const report = await admin.reports.full(waiting);
  expect(report.verdict).toBe("hold");
  expect(report.findings.find((f) => f.rule === "text.url-install")?.quote).toContain("pip install");
}, NEEDS);

scenario("IT-ADMIN-009 Admin reads of private content are audited", async (world) => {
  const admin = await world.admins.create();
  const publisher = await world.publishers.create({ handle: "priv" });
  await world.admins.promoted(await clean(world, publisher, "priv", "1.0.0"));
  const waiting = await held(world, publisher, "priv", "1.1.0");
  await world.admins.makePrivate(waiting);
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  const reporter = await world.users.create();
  await reporter.signIn();
  const filed = await world.reports.file(reporter, pack, { kind: "security", version: "1.0.0", severity: "high", title: "Token leaks to logs" });

  expect(await admin.audit()).toEqual([]);
  await admin.queue.open(waiting);
  await admin.reports.full(waiting);
  await admin.reports.proseScreen(waiting);
  await admin.reports.security(filed);
  const reads = await admin.audit();
  expect(reads.map((r) => r.verb).sort()).toEqual(["read.private-pack", "read.prose-screen", "read.report", "read.validation-report"]);
  for (const read of reads) expect(read).toMatchObject({ action: "admin.action", actor: admin.email });
  expect(reads.map((r) => r.target?.split(":")[1]).sort()).toEqual(["private-pack", "prose-screen", "report", "validation-report"]);

  await world.agents.anonymous().pack(pack);
  await admin.queue.list();
  expect(await admin.audit()).toHaveLength(4);
}, NEEDS);

/** A listed pack with a readable RULES.md; returns the anchor of its Secrets section. */
async function commentable(world: World, name: string) {
  const pack = await world.packs.public(name, { versions: ["1.0.0"] });
  await world.search.list(pack, { pitch: "Cloud rules", category: "cloud", parts: ["rules"] });
  await pack.seedContents("1.0.0", { readme: "# gcp\n", files: [{ path: "RULES.md", text: "# Rules\nBe careful.\n## Secrets\nNever print them.\n" }] });
  const view = await pack.page("contents");
  if (!("anchors" in view)) throw new Error("the Contents tab is missing");
  const section = view.anchors.find((a) => a.includes("RULES.md") && a.endsWith("~secrets"));
  if (!section) throw new Error("RULES.md has no secrets section");
  return { pack, section };
}

scenario("IT-ADMIN-002 Review-queue actions are audited with the actor", async (world) => {
  await world.access.seedRegistryKeys();
  const admin = await world.admins.create();
  const publisher = await world.publishers.create({ handle: "q" });
  const owner = await world.publishers.create({ handle: "own", mfa: "passkey" });
  const waiting = await held(world, publisher, "q", "1.0.0");
  const org = await owner.orgs.create("acme");
  await world.admins.proveDomain(org, "acme.com");
  await org.requireMfa("passkey");
  await org.applyVerified();
  const pack = await world.packs.public("@gcp/pack", { versions: ["1.0.0"] });
  const reporter = await world.users.create();
  await reporter.signIn();
  const filed = await world.reports.file(reporter, pack, { kind: "security", version: "1.0.0", severity: "high", title: "Token leaks to logs" });
  const [hidden, rival, pinned, miner] = [
    await world.packs.public("@gcp/hidden", { versions: ["1.0.0"] }),
    await world.packs.public("@gcp/rival", { versions: ["1.0.0"] }),
    await world.packs.public("@gcp/pinned", { versions: ["1.0.0"] }),
    await world.packs.public("@gcp/miner", { versions: ["1.0.0", "1.1.0"] }),
  ] as const;
  for (const listing of [hidden, rival, pinned, miner]) await world.search.list(listing, { pitch: "Format markdown tables", category: "backend" });
  const author = await world.users.create();
  await author.signIn();
  await world.community.setAge(author, "3d");
  const review = (await world.community.review(author, rival, { rating: 1, body: "Unfair." })) as { id: string };
  const noise = (await world.reportAbuse(reporter, hidden, { category: "other", details: "Not what it says." })) as { id: string };
  const malware = (await world.reportAbuse(reporter, miner, { category: "malware", details: "Runs a miner.", version: "1.1.0" })) as { id: string };
  const token = `${"ghp"}_${"aB3dE5gH7jK9mN1pQ3sT5vX7zC9eF1hJ3kL5"}`;
  const { pack: talked, section } = await commentable(world, "@gcp/talked");
  const kept = (await world.community.comment(author, talked, { section, body: `Use ${token} here` })) as { id: string };
  const gone = (await world.community.comment(author, talked, { section, body: `Or ${token} there` })) as { id: string };

  const listed = await admin.queue.list();
  expect(listed.map((e) => e.kind)).toEqual(["abuse-report", "report", "held-version", "application", "abuse-report"]);
  expect(listed[0]).toMatchObject({ id: malware.id, priority: true });
  expect(listed[1]).toMatchObject({ id: filed.id, priority: true });
  expect((await admin.moderation.comments.held()).map((c) => c.id).sort()).toEqual([kept.id, gone.id].sort());

  await admin.queue.dismissReport(filed);
  expect((await world.reports.read(reporter, filed)) as { status: string }).toMatchObject({ status: "wont_fix" });
  await admin.queue.reject(waiting, "Not acceptable");
  await admin.applications.deny(org, "The domain only redirects to another site");
  expect(world.mail.inbox(owner).latest().text).toContain("Reason: The domain only redirects to another site");
  await world.clock.advance("30d");
  await owner.signIn();
  await org.applyVerified();
  await admin.applications.approve(org);
  await expect(world.profiles.profile(org)).resolves.toMatchObject({ verifiedPublisher: true });
  await admin.applications.revoke(org, "Impersonation");
  await expect(world.profiles.profile(org)).resolves.toMatchObject({ verifiedPublisher: false });

  await admin.moderation.dismiss(noise);
  await admin.moderation.hidePack(hidden);
  await admin.moderation.hideReview(review, "Not about the pack.");
  await admin.moderation.act(malware, { action: "yank", reason: "malware" });
  await admin.moderation.quarantinePack(pinned, "Held for a look");
  await admin.moderation.suspend(publisher.scope, "Repeated malware");
  await admin.moderation.comments.release(kept);
  await admin.moderation.comments.remove(gone, "It carries a credential.");

  expect(await miner.version("1.1.0").status()).toBe("yanked");
  expect(await pinned.version("1.0.0").status()).toBe("quarantined");
  await expect(world.community.reviews(rival)).resolves.toMatchObject({ reviewCount: 0 });
  await expect(admin.holds.list()).resolves.toContain(publisher.scope.name);
  const ids = (await world.search.site("format markdown tables", {})).ids;
  for (const other of [miner, rival, pinned]) expect(ids.indexOf(hidden.name)).toBeGreaterThan(ids.indexOf(other.name));
  const thread = async (who?: typeof author) => ((await world.community.comments(talked, section, who)) as Array<{ id: string }>).map((c) => c.id);
  expect(await thread()).toEqual([kept.id]);
  expect(await thread(author)).toEqual([kept.id]);
  expect((await admin.queue.list()).map((e) => e.kind)).toEqual([]);

  const entries = await admin.audit();
  expect(entries.map((e) => e.verb).sort()).toEqual([
    "abuse.dismiss", "comment.release", "comment.remove", "pack.hide", "pack.quarantine", "publisher.suspend", "report.dismiss",
    "review.hide", "review.reject", "verified.approve", "verified.deny", "verified.revoke", "version.yank",
  ]);
  for (const entry of entries) expect(entry).toMatchObject({ action: "admin.action", actor: admin.email });
}, NEEDS);

scenario("IT-ADMIN-004 Admins grant or revoke Verified Publisher, from an application or directly, with no subscription", async (world) => {
  const admin = await world.admins.create();
  const p = await world.publishers.create({ handle: "p", mfa: "passkey" });
  const c = await world.publishers.create({ handle: "c", mfa: "passkey" });
  const acme = await p.orgs.create("acme");
  const registry = await c.orgs.create("registry");
  const challenge = await acme.verifyDomain("acme.com");
  challenge.publishTxt();
  await acme.checkDomain(challenge);
  await world.admins.proveDomain(registry, "registry.example");
  await acme.requireMfa("passkey");
  await acme.applyVerified();

  await admin.applications.approve(acme);
  await admin.applications.grant(registry);
  const profiles = [await world.profiles.profile(acme), await world.profiles.profile(registry)];
  for (const profile of profiles) expect(profile).toMatchObject({ verifiedPublisher: true });
  expect(without(profiles[0]!, "name", "verifiedDomain", "mark")).toEqual(without(profiles[1]!, "name", "verifiedDomain", "mark"));
  for (const profile of profiles) expect(profile).toMatchObject({ mark: { hoverLabel: "Verified Publisher" } });

  await admin.applications.revoke(acme, "Impersonation");
  await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedPublisher: false });
  await expect(admin.applications.grant(registry)).toBeRefusedSaying("already");

  expect((await admin.audit()).map((e) => e.verb).sort()).toEqual(["verified.approve", "verified.grant", "verified.revoke"]);
  const calls = await world.recorder.invocations({ kind: "http" });
  expect(calls.filter((call) => /polar|stripe|paddle|payment|checkout/i.test(call.target))).toEqual([]);
}, NEEDS);
