import { expect, NotFound, scenario } from "@packserver/test-world";

scenario("IT-SCOPE-001 A pack is @scope/name and a scope has exactly one owner", async (world) => {
  const p = await world.publishers.create({ handle: "p" });
  const q = await world.publishers.create({ handle: "q" });
  const acme = await q.orgs.create("acme");
  const mine = await world.packs.public("@p/gcp");
  const theirs = await world.packs.public("@acme/gcp");

  await expect(mine.read()).resolves.toMatchObject({ outcome: "found", name: "@p/gcp" });
  await expect(theirs.read()).resolves.toMatchObject({ outcome: "found", name: "@acme/gcp" });
  await expect(world.profiles.profile(p.scope)).resolves.toMatchObject({ kind: "user", packs: ["@p/gcp"] });
  await expect(world.profiles.profile(acme)).resolves.toMatchObject({ kind: "org", packs: ["@acme/gcp"] });

  const personal = world.orgs.get(p.scope.name, p);
  await expect(personal.people()).resolves.toMatchObject({ people: [{ handle: "p", role: "owner" }], invitations: [] });
  await expect(personal.invite(q).as("owner")).toBeRefused("forbidden");
  await expect(personal.invite({ email: q.email }).as("owner")).toBeRefused("forbidden");
  await expect(personal.people()).resolves.toMatchObject({ people: [{ handle: "p", role: "owner" }] });
  await expect(acme.people()).resolves.toMatchObject({ people: [{ handle: "q", role: "owner" }] });
});

scenario("IT-SCOPE-002 A publisher creates an org scope and becomes its owner", async (world) => {
  const p = await world.publishers.create({ handle: "p" });

  await expect(p.orgs.create("acme", { assertion: "none" })).toBeRefused("step-up");
  await expect(world.profiles.profile({ name: "acme" })).resolves.toBeInstanceOf(NotFound);

  const org = await p.orgs.create("acme");
  await expect(org.people()).resolves.toMatchObject({ you: "owner", people: [{ handle: "p", role: "owner" }], invitations: [] });
  await expect(world.profiles.profile(org)).resolves.toMatchObject({ kind: "org", name: "acme" });
  await expect(p.orgs.create("acme")).toBeRefusedSaying("taken");

  const newcomer = world.users.newcomer();
  await newcomer.signIn();
  await expect(world.orgs.create(newcomer, "another")).toBeRefusedSaying("handle");
});

scenario("IT-SCOPE-003 Org owners manage the org's people and roles; maintainers cannot", async (world) => {
  const p = await world.publishers.create({ handle: "p" });
  const m = await world.publishers.create({ handle: "m" });
  const u = await world.publishers.create({ handle: "u" });
  const org = await p.orgs.create("acme");
  await org.invite(m).as("maintainer");

  const asMaintainer = org.as(m);
  await expect(asMaintainer.invite(u).as("maintainer")).toBeRefused("forbidden");
  await expect(asMaintainer.setRole(m, "owner")).toBeRefused("forbidden");
  await expect(asMaintainer.remove(p)).toBeRefused("forbidden");
  await expect(org.people()).resolves.toMatchObject({ people: [{ handle: "m", role: "maintainer" }, { handle: "p", role: "owner" }] });

  await expect(org.invite(u).as("maintainer", { assertion: "none" })).toBeRefused("step-up");
  await org.invite(u).as("maintainer");
  const invited = await org.invite({ email: "newcomer@example.test" }).as("maintainer");
  await expect(org.people()).resolves.toMatchObject({ invitations: [{ email: "newcomer@example.test", role: "maintainer" }] });
  await org.setRole(m, "owner");
  await org.remove(invited!);

  const people = await org.people();
  expect(people).toMatchObject({
    people: [{ handle: "m", role: "owner" }, { handle: "p", role: "owner" }, { handle: "u", role: "maintainer" }],
    invitations: [],
  });
  const answer = await org.peopleObservation();
  expect(answer.body).not.toMatch(/member/i);
  await expect(org.setRole(p, "maintainer", { assertion: "none" })).toBeRefused("step-up");
});

scenario("IT-SCOPE-012 Scope names, pack names and versions are never recycled", async (world) => {
  const p = await world.publishers.create({ handle: "p" });
  const gone = await p.orgs.create("gone");
  await gone.delete();
  await expect(world.profiles.profile(gone)).resolves.toBeInstanceOf(NotFound);

  await expect(p.orgs.create("gone")).toBeRefusedSaying("taken");
  await expect(world.profiles.profile(gone)).resolves.toBeInstanceOf(NotFound);
  const newcomer = world.users.newcomer();
  await newcomer.signIn();
  await expect(newcomer.chooseHandle(world.alias("gone"))).toBeRefusedSaying("taken");
});

scenario("IT-SCOPE-013 An org that owns packs cannot be deleted", async (world) => {
  const p = await world.publishers.create({ handle: "p" });
  const w = await world.publishers.create({ handle: "w" });
  const org = await p.orgs.create("acme");
  const target = await w.orgs.create("target");
  const pack = await world.packs.public("@acme/gcp");

  await expect(org.delete()).toBeRefusedSaying("@acme/gcp");
  await expect(org.delete({ assertion: "none" })).toBeRefused("step-up");
  await expect(world.profiles.profile(org)).resolves.toMatchObject({ name: "acme" });

  const offer = await world.transfers.offer(pack, { to: target, by: p });
  await offer.accept(w);
  await org.delete();
  await expect(world.profiles.profile(org)).resolves.toBeInstanceOf(NotFound);
  await expect(world.profiles.profile(target)).resolves.toMatchObject({ packs: ["@target/gcp"] });
});

scenario("IT-SCOPE-014 A transfer is an offer only an owner makes and the receiving owner accepts within 7 days", async (world) => {
  const p = await world.publishers.create({ handle: "p" });
  const m = await world.publishers.create({ handle: "m" });
  const w = await world.publishers.create({ handle: "w" });
  const v = await world.publishers.create({ handle: "v" });
  const source = await p.orgs.create("source");
  await source.invite(m).as("maintainer");
  const target = await w.orgs.create("target");
  const other = await v.orgs.create("other");
  const first = await world.packs.public("@source/first");
  const second = await world.packs.public("@source/second");

  await expect(world.transfers.offer(first, { to: target, by: m })).toBeRefused("forbidden");
  await expect(world.transfers.offer(first, { to: target, by: p, assertion: "none" })).toBeRefused("step-up");
  const offer = await world.transfers.offer(first, { to: target, by: p });
  const lapsing = await world.transfers.offer(second, { to: other, by: p });
  await expect(world.profiles.profile(source)).resolves.toMatchObject({ packs: ["@source/first", "@source/second"] });
  await expect(world.transfers.incoming(w)).resolves.toMatchObject([{ id: offer.id, pack: "@source/first", to: "target" }]);

  await expect(offer.accept(p)).toBeRefused("forbidden");
  await expect(offer.accept(w, { assertion: "none" })).toBeRefused("step-up");
  await offer.accept(w);
  await expect(world.profiles.profile(source)).resolves.toMatchObject({ packs: ["@source/second"] });
  await expect(world.profiles.profile(target)).resolves.toMatchObject({ packs: ["@target/first"] });
  await expect(world.transfers.movedTo(first)).resolves.toBe("@target/first");

  await world.clock.advance("7d1h");
  await v.signIn();
  await expect(lapsing.accept(v)).toBeRefusedSaying("lapsed");
  await expect(world.profiles.profile(source)).resolves.toMatchObject({ packs: ["@source/second"] });
  await expect(world.transfers.movedTo(second)).resolves.toBeInstanceOf(NotFound);
});

scenario("IT-SCOPE-015 The public profile shows proofs and packs; the mark shows the proof, not a badge", async (world) => {
  const owner = await world.publishers.create({ handle: "owner" });
  const acme = await owner.orgs.create("acme");
  await acme.seedProof({ domain: "acme.com", githubOrg: "acme", verifiedPublisher: true });
  await world.packs.public("@acme/gcp");
  await world.packs.public("@acme/aws");
  await world.packs.public("@acme/secret", { visibility: "private" });
  const plain = await owner.orgs.create("plain");

  const verified = await world.profiles.profile(acme);
  expect(verified).toMatchObject({
    verifiedDomain: "acme.com",
    verifiedGithubOrg: "acme",
    verifiedPublisher: true,
    mark: { kind: "domain", text: "● acme.com", hoverLabel: "Verified Publisher" },
    packs: ["@acme/aws", "@acme/gcp"],
  });
  expect((verified as { mark: { text: string } }).mark.text).not.toMatch(/verified publisher/i);

  const githubOnly = await owner.orgs.create("hubonly");
  await githubOnly.seedProof({ githubOrg: "hubonly" });
  await expect(world.profiles.profile(githubOnly)).resolves.toMatchObject({ mark: { kind: "github", text: "● github.com/hubonly", hoverLabel: null } });
  await expect(world.profiles.profile(plain)).resolves.toMatchObject({
    verifiedPublisher: false,
    mark: { kind: "unproven", text: "○ Unproven", hoverLabel: null },
    packs: [],
  });
});

scenario("IT-SCOPE-016 Cross-scope actions are refused by identity", async (world) => {
  const a = await world.publishers.create({ handle: "a" });
  const b = await world.publishers.create({ handle: "b" });
  const m = await world.publishers.create({ handle: "m" });
  const orgA = await a.orgs.create("orga");
  const orgB = await b.orgs.create("orgb");
  await orgA.invite(m).as("maintainer");
  const open = await world.packs.public("@orgb/open");
  const hidden = await world.packs.public("@orgb/hidden", { visibility: "private" });

  await expect(world.transfers.tryOffer(open, { to: orgA, by: m })).toBeRefused("forbidden");
  await expect(orgB.as(m).remove(b)).toBeRefused("forbidden");
  await expect(orgB.as(m).invite(m).as("owner")).toBeRefused("forbidden");
  await expect(orgB.as(m).people()).toBeRefused("forbidden");
  await expect(world.transfers.tryOffer(hidden, { to: orgA, by: m })).resolves.toBeInstanceOf(NotFound);
  await expect(world.transfers.tryOffer(world.packs.nonexistent("@orgb/nothing"), { to: orgA, by: m })).resolves.toBeInstanceOf(NotFound);

  await expect(orgB.people()).resolves.toMatchObject({ people: [{ handle: "b", role: "owner" }], invitations: [] });
  await expect(world.profiles.profile(orgB)).resolves.toMatchObject({ packs: ["@orgb/open"] });
  await expect(world.transfers.incoming(a)).resolves.toEqual([]);
});
