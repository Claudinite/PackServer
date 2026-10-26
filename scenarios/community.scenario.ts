import { expect, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage"] };
const MB = 1024 * 1024;

/** A signed-in person with the system's own name for them. */
async function person(world: World) {
  const who = await world.users.create();
  await who.signIn();
  return who;
}

/** A public pack whose scope the given person owns, and a maintainer who publishes. */
async function packWith(world: World, name: string, opts: { versions?: string[]; linked?: boolean } = {}) {
  const pack = await world.packs.public(name, { versions: opts.versions ?? ["1.0.0", "1.0.1", "1.0.2"], ...(opts.linked ? { verification: { sourceVerified: true } } : {}) });
  const owner = await person(world);
  const maintainer = await person(world);
  await world.reports.seedRole(pack, owner, "owner");
  await world.reports.seedRole(pack, maintainer, "maintainer");
  return { pack, owner, maintainer };
}

scenario("IT-MOD-002 Security reports are private with a 90-day timer and a 7-day reminder", async (world) => {
  const { pack, owner, maintainer } = await packWith(world, "@acme/gcp");
  const reporter = await person(world);
  const outsider = await person(world);
  const scoreBefore = (await pack.version("1.0.1").detail()).score;

  const filed = await world.reports.file(reporter, pack, { kind: "security", version: "1.0.1", severity: "high", title: "Token leaks to logs" });
  const filedAt = await world.clock.now();
  expect(filed.disclosureEnds?.getTime()).toBe(filedAt.getTime() + 90 * 24 * 3600 * 1000);

  expect(await world.reports.issues(pack)).toEqual([]);
  expect(await world.reports.issues(pack, maintainer)).toEqual([]);
  for (const reader of [owner, maintainer, reporter]) expect(await world.reports.read(reader, filed)).toMatchObject({ id: filed.id, kind: "security" });
  expect(await world.reports.registrySecurity.read(filed)).toMatchObject({ id: filed.id });
  expect(await world.reports.read(outsider, filed)).toBeNotFound();
  expect(await world.reports.read(undefined, filed)).toBeNotFound();

  expect((await pack.version("1.0.1").detail()).score).toEqual(scoreBefore);
  expect(await world.reports.advisories(pack)).toEqual([]);

  await world.clock.advance("82d");
  expect(await world.reports.sweep(pack)).toMatchObject({ reminded: 0 });
  await world.clock.advance("1d");
  expect(await world.reports.sweep(pack)).toMatchObject({ reminded: 1 });
  await world.reports.deliver();
  expect(world.mail.inbox(owner).all().map((m) => m.subject)).toEqual(["A security report on " + pack.systemName + " is disclosed in 7 days"]);
  expect(world.mail.inbox(outsider).all()).toEqual([]);
  expect(await world.reports.sweep(pack)).toMatchObject({ reminded: 0 });
}, NEEDS);

scenario("IT-MOD-003 No security contact routes to registry security", async (world) => {
  const { pack, owner } = await packWith(world, "@acme/gcp");
  const reporter = await person(world);

  const filed = await world.reports.file(reporter, pack, { kind: "security" });
  expect(filed.route).toBe("registry_security");
  expect(await world.reports.queued("registry-security", pack)).toHaveLength(1);
  expect(await world.reports.queued(owner, pack)).toEqual([]);
  expect(await world.reports.inbox(owner, pack)).toMatchObject({ needsSecurityContact: true });

  // Contrast: with a contact, the contact is told as well.
  await world.reports.setSecurityContact(owner, pack, "security@acme.test");
  expect(await world.reports.inbox(owner, pack)).toMatchObject({ needsSecurityContact: false });
  const second = await world.reports.file(reporter, pack, { kind: "security", title: "Another" });
  expect(second.route).toBe("security_contact");
  expect(await world.reports.queued({ address: "security@acme.test" }, pack)).toHaveLength(1);
}, NEEDS);

scenario("IT-MOD-004 Attachments with secrets or active content are blocked", async (world) => {
  const { pack } = await packWith(world, "@acme/gcp");
  const reporter = await person(world);
  const token = `${"ghp"}_${"aB3dE5gH7jK9mN1pQ3sT5vX7zC9eF1hJ3kL5"}`;

  await expect(world.reports.file(reporter, pack, { kind: "bug", attachments: [{ name: "run.log", text: `token=${token}\n` }] })).toBeRefusedSaying("secret");

  const filed = await world.reports.file(reporter, pack, {
    kind: "bug",
    attachments: [
      { name: "evil.svg", text: "<svg xmlns='x'><script>alert(1)</script></svg>" },
      { name: "page.html", text: "<html><script>alert(1)</script></html>" },
      { name: "shot.png", bytes: 2048 },
    ],
  });
  const [svg, html, png] = filed.attachments;
  for (const active of [svg, html]) {
    expect(await world.reports.download(reporter, filed, active!)).toEqual({ disposition: "attachment", contentType: "application/octet-stream", sniffable: false });
  }
  expect(await world.reports.download(reporter, filed, png!)).toEqual({ disposition: "inline", contentType: "image/png", sniffable: false });

  // Size: a 4 MB image attaches, a 6 MB one is refused and leaves no report behind.
  await world.reports.file(reporter, pack, { kind: "bug", attachments: [{ name: "big.png", bytes: 4 * MB }] });
  const before = (await world.reports.mine(reporter)).length;
  await expect(world.reports.file(reporter, pack, { kind: "bug", attachments: [{ name: "huge.png", bytes: 6 * MB }] })).toBeRefusedSaying("5 MB");
  expect(await world.reports.mine(reporter)).toHaveLength(before);
}, NEEDS);

scenario("IT-MOD-005 Reporters see similar existing issues first", async (world) => {
  const { pack } = await packWith(world, "@acme/gcp");
  const first = await person(world);
  const reporter = await person(world);
  await world.reports.file(first, pack, { kind: "bug", title: "Guard blocks git push" });
  await world.reports.file(first, pack, { kind: "bug", title: "README has a typo" });
  await world.reports.file(first, pack, { kind: "security", title: "Guard blocks git push" });

  const similar = await world.reports.similar(reporter, pack, "guard blocking git push");
  expect(similar.map((s) => s.title)).toEqual(["Guard blocks git push"]);
  expect(await world.reports.similar(reporter, pack, "completely different words")).toEqual([]);
}, NEEDS);

scenario("IT-MOD-006 Publishers set status; reporters are notified", async (world) => {
  const { pack, maintainer } = await packWith(world, "@acme/gcp");
  const reporter = await person(world);
  const bystander = await person(world);
  const filed = await world.reports.file(reporter, pack, { kind: "bug" });

  await expect(world.reports.setStatus(bystander, filed, { status: "acknowledged" })).toBeRefused("forbidden");
  await expect(world.reports.setStatus(reporter, filed, { status: "fixed", fixedIn: "1.0.1" })).toBeRefused("forbidden");
  await expect(world.reports.setStatus(maintainer, filed, { status: "fixed", fixedIn: "9.9.9" })).toBeRefusedSaying("9.9.9");

  const steps = [
    { change: { status: "acknowledged" as const }, shown: { status: "acknowledged", fixed_in: null } },
    { change: { status: "fixed" as const, fixedIn: "1.0.1" }, shown: { status: "fixed", fixed_in: "1.0.1" } },
    { change: { status: "wont_fix" as const }, shown: { status: "wont_fix", fixed_in: null } },
    { change: { status: "duplicate" as const }, shown: { status: "duplicate", fixed_in: null } },
  ];
  for (const step of steps) expect(await world.reports.setStatus(maintainer, filed, step.change)).toMatchObject(step.shown);

  await world.reports.deliver();
  expect(world.mail.inbox(reporter).all().map((m) => m.subject)).toEqual([
    `Your report on ${pack.systemName} is acknowledged`,
    `Your report on ${pack.systemName} is fixed`,
    `Your report on ${pack.systemName} is marked won't fix`,
    `Your report on ${pack.systemName} is marked as a duplicate`,
  ]);
  expect(world.mail.inbox(reporter).all()[1]?.text).toContain("Fixed in 1.0.1");
  expect(world.mail.inbox(bystander).all()).toEqual([]);
}, NEEDS);

scenario("IT-MOD-007 Registry security publishes advisories that attach to versions and are returned by get_pack", async (world) => {
  const { pack, maintainer } = await packWith(world, "@acme/gcp");
  const reporter = await person(world);
  const first = await world.reports.file(reporter, pack, { kind: "security", version: "1.0.0", title: "Token leaks to logs", repro: "SECRET-REPRO-STEPS" });
  const second = await world.reports.file(reporter, pack, { kind: "security", version: "1.0.1", title: "Path traversal in unpack" });

  await world.reports.setStatus(maintainer, first, { status: "fixed", fixedIn: "1.0.2" });
  await world.reports.deliver();
  expect(world.mail.inbox({ email: world.reports.securityAddress }).all().map((m) => m.subject)).toContain(`Security report marked fixed on ${pack.systemName}`);
  expect(await world.reports.advisories(pack)).toEqual([]);

  await world.reports.registrySecurity.publishAdvisory(first, { summary: "A token could reach logs.", versions: ["1.0.0", "1.0.1"], fixedIn: "1.0.2" });
  for (const [version, affected] of [["1.0.0", true], ["1.0.1", true], ["1.0.2", false]] as const) {
    expect((await world.reports.advisories(pack, version)).map((a) => a.summary)).toEqual(affected ? ["A token could reach logs."] : []);
  }

  // The second report's timer runs out: registry security is told, and the advisory it then publishes is public.
  await world.clock.advance("90d");
  expect(await world.reports.sweep(pack)).toMatchObject({ expired: 1 });
  expect((await world.reports.queued("registry-security", pack)).map((n) => n.data.event)).toContain("timer_expired");
  await world.reports.registrySecurity.publishAdvisory(second, { summary: "Unpacking could write outside the target.", versions: ["1.0.1"] });
  expect((await world.reports.advisories(pack, "1.0.2")).map((a) => a.summary)).toEqual([]);
  expect((await world.reports.advisories(pack, "1.0.1")).map((a) => a.summary).sort()).toEqual(["A token could reach logs.", "Unpacking could write outside the target."]);

  // The advisory is the only public trace of either report.
  expect(await world.reports.issues(pack)).toEqual([]);
  const everything = JSON.stringify(await world.reports.advisories(pack));
  for (const private_ of ["SECRET-REPRO-STEPS", "Token leaks to logs", "Path traversal in unpack"]) expect(everything).not.toContain(private_);
}, NEEDS);

scenario("IT-MOD-017 Signed-in people see their own reports", async (world) => {
  const { pack } = await packWith(world, "@acme/gcp");
  const author = await person(world);
  const other = await person(world);
  const bug = await world.reports.file(author, pack, { kind: "bug", title: "A bug" });
  const security = await world.reports.file(author, pack, { kind: "security", title: "A hole" });

  expect((await world.reports.mine(author)).map((r) => r.id).sort()).toEqual([bug.id, security.id].sort());
  expect(await world.reports.mine(other)).toEqual([]);
  expect(await world.reports.read(other, security)).toBeNotFound();
}, NEEDS);
