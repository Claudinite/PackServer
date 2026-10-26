import { accepted, expect, scenario, type World } from "@packserver/test-world";

const WORKFLOW = ".github/workflows/publish.yml";

/** An org `@acme` owned by P (and Q when asked), with M as a maintainer. */
async function acmeOrg(world: World, o: { coOwner?: boolean } = {}) {
  const p = await world.publishers.create({ handle: "p" });
  const m = await world.publishers.create({ handle: "m" });
  const org = await p.orgs.create("acme");
  await org.invite(m).as("maintainer");
  await world.invitations.accept(m, (await world.invitations.pending(m))[0]!);
  let q;
  if (o.coOwner) {
    q = await world.publishers.create({ handle: "q" });
    await org.invite(q).as("owner");
    await world.invitations.accept(q, (await world.invitations.pending(q))[0]!);
  }
  return { p, m, q, org };
}

scenario("IT-PUB-001 Register a trusted publisher; a pending name is reserved 14 days, within the scope", async (world) => {
  const { p, m } = await acmeOrg(world);
  const z = await world.publishers.create({ handle: "z" });
  const repo = world.ci.repo("acme/packs", { id: 5150, ownerId: 1001 });
  await world.trusted.seedPending("acme", 9, { repo });

  const reserved = await world.trusted.register("@acme/new", { by: p, repo, workflow: WORKFLOW, environment: "release", path: "packs/new" });
  expect(reserved.pending).toBe(true);
  await expect(world.trusted.list("@acme/new", p)).resolves.toMatchObject([{ id: reserved.id, pending: true, repository: "acme/packs", workflow: WORKFLOW }]);

  await expect(m.publish(world.archive("gcp", { version: "1.0.0" })).as("@acme/new@1.0.0")).toBeRefusedSaying("reserved");
  expect(await world.ci.staging.objects("acme")).toEqual([]);
  await z.publish(world.archive("gcp", { version: "1.0.0" })).as("@z/new@1.0.0");
  await expect(world.trusted.register("@acme/another", { by: p, repo, workflow: WORKFLOW, path: "packs/another" })).toBeRefused("quota");
  await expect(world.trusted.register("@acme/new", { by: m, repo, workflow: WORKFLOW, path: "packs/new" })).toBeRefused("forbidden");

  const run = world.ci.workflow({ repo, environment: "release", ref: "refs/tags/new/1.0.0" });
  accepted(await run.exchange("@acme/new", "1.0.0"));

  await world.clock.advance("14d1h");
  await p.signIn();
  await m.signIn();
  await expect(world.trusted.list("@acme/new", p)).resolves.toEqual([]);
  await m.publish(world.archive("gcp", { version: "1.0.0" })).as("@acme/new@1.0.0");
});

scenario("IT-PUB-002 Changing a trusted publisher needs an assertion and emails every owner", async (world) => {
  const { p, q, org } = await acmeOrg(world, { coOwner: true });
  const owners = [p, q!];
  await org.people();
  await world.packs.public("@acme/gcp");
  const repo = world.ci.repo("acme/packs", { id: 5150, ownerId: 1001 });

  await expect(world.trusted.register("@acme/gcp", { by: p, repo, workflow: WORKFLOW, path: "packs/gcp", assertion: "none" })).toBeRefused("step-up");
  const added = await world.trusted.register("@acme/gcp", { by: p, repo, workflow: WORKFLOW, path: "packs/gcp" });
  expect(added.pending).toBe(false);
  for (const owner of owners) expect(world.mail.inbox(owner).all().filter((n) => /trusted publisher added/i.test(n.subject))).toHaveLength(1);

  await expect(world.trusted.change(added, { by: p, workflow: ".github/workflows/release.yml", assertion: "none" })).toBeRefused("step-up");
  await expect(world.trusted.list("@acme/gcp", p)).resolves.toMatchObject([{ workflow: WORKFLOW }]);
  const forOtherPack = await p.assertionFor({ action: "trusted-publisher.change", target: "acme/other" });
  await expect(world.trusted.change(added, { by: p, workflow: ".github/workflows/release.yml", assertion: forOtherPack })).toBeRefused("step-up");

  await expect(world.trusted.change(added, { by: p, events: ["issue_comment"] })).toBeRefusedSaying("events");
  await expect(world.trusted.change(added, { by: p, events: ["pull_request_target"] })).toBeRefusedSaying("events");
  expect(world.mail.inbox(p).all().filter((n) => /changed/i.test(n.subject))).toHaveLength(0);

  const changed = await world.trusted.change(added, { by: p, workflow: ".github/workflows/release.yml" });
  expect(changed).toMatchObject({ id: added.id, workflow: ".github/workflows/release.yml" });
  for (const owner of owners) {
    const notice = world.mail.inbox(owner).latest();
    expect(notice.subject).toMatch(/trusted publisher changed/i);
    expect(notice.text).toContain(`workflow ${WORKFLOW} -> .github/workflows/release.yml`);
  }

  const moved = world.ci.repo("acme/packs", { id: 6262, ownerId: 2002 });
  await world.trusted.change(changed, { by: p, repo: moved });
  for (const owner of owners) {
    const text = world.mail.inbox(owner).latest().text;
    expect(text).toContain("repository id 5150 -> 6262");
    expect(text).toContain("repository owner id 1001 -> 2002");
  }
});

scenario("IT-PUB-008 Trusted-publishing-only refuses web uploads", async (world) => {
  const { p, m } = await acmeOrg(world);
  await world.packs.public("@acme/gcp");
  const repo = world.ci.repo("acme/packs", { id: 5150, ownerId: 1001 });
  await world.trusted.register("@acme/gcp", { by: p, repo, workflow: WORKFLOW, environment: "release", path: "packs/gcp" });

  await world.trusted.setOnly("@acme/gcp", true, p);
  await expect(m.publish(world.archive("gcp", { version: "2.0.0" })).as("@acme/gcp@2.0.0")).toBeRefused("trusted-only");
  await expect(world.trusted.setOnly("@acme/gcp", false, m)).rejects.toMatchObject({ reason: "forbidden" });
  await expect(world.trusted.setOnly("@acme/gcp", false, p, { assertion: "none" })).rejects.toMatchObject({ reason: "step-up" });
  expect(await world.ci.staging.objects("acme")).toEqual([]);

  const run = world.ci.workflow({ repo, environment: "release", ref: "refs/tags/gcp/9.0.0" });
  const credential = accepted(await run.exchange("@acme/gcp", "9.0.0"));
  expect(accepted(await credential.upload(new Uint8Array(1024).fill(7)))).toMatchObject({ sizeBytes: 1024 });

  const before = world.mail.inbox(p).all().length;
  await world.trusted.setOnly("@acme/gcp", false, p);
  await m.publish(world.archive("gcp", { version: "2.0.0" })).as("@acme/gcp@2.0.0");
  expect(world.mail.inbox(p).all().length).toBe(before + 1);
  expect(world.mail.inbox(p).latest().text).toContain("turned off");
});

scenario("IT-VAL-038 The next version after a publisher-change event is a first publish (emitter half)", async (world) => {
  const { p } = await acmeOrg(world);
  await world.packs.public("@acme/changed");
  await world.packs.public("@acme/quiet");
  const repo = world.ci.repo("acme/packs", { id: 5150, ownerId: 1001 });

  await expect(world.trusted.changes("@acme/changed")).resolves.toEqual([]);
  const registered = await world.trusted.register("@acme/changed", { by: p, repo, workflow: WORKFLOW, path: "packs/changed" });
  await expect(world.trusted.changes("@acme/changed")).resolves.toEqual([{ kind: "trusted-publisher", consumed: false }]);
  await world.trusted.change(registered, { by: p, workflow: ".github/workflows/release.yml" });
  await expect(world.trusted.changes("@acme/changed")).resolves.toHaveLength(2);
  await expect(world.trusted.changes("@acme/quiet")).resolves.toEqual([]);

  await expect(world.trusted.register("@acme/changed", { by: p, repo, workflow: WORKFLOW, path: "packs/changed", assertion: "none" })).toBeRefused("step-up");
  await expect(world.trusted.changes("@acme/changed")).resolves.toHaveLength(2);
});
