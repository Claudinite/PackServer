import { expect, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock"] };
const IP = "203.0.113.9";
const SENSITIVE = [
  "login", "factor.added", "factor.removed", "provider.linked", "token.minted", "token.revoked", "grant.changed",
  "trusted_publisher.changed", "publish.approved", "visibility.changed", "version.yanked", "admin.action",
] as const;

const person = (world: World, name: string) => ({ kind: "user" as const, id: world.alias(name) });

scenario("IT-AUDIT-001 Every sensitive action writes an entry", async (world) => {
  const alice = person(world, "alice");
  for (const action of SENSITIVE) await world.audit.record(alice, action, `target:${action}`, { user_id: alice.id });
  await world.audit.flush();
  const entries = await world.audit.for({ user: alice.id });
  expect(entries).toHaveLength(12);
  for (const e of entries) {
    expect(e).toMatchObject({ actor_id: alice.id, actor_kind: "user" });
    expect(e.target).toBe(`target:${e.action}`);
    expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }
  expect(entries.map((e) => e.action).sort()).toEqual([...SENSITIVE].sort());

  const batches = await world.audit.batches();
  expect(batches.flatMap((b) => b.events)).toHaveLength(12);
  // No binding the Workers hold can edit or delete a batch; the write path itself refuses a replacement.
  expect(await world.audit.overwriteRefused()).toBe(true);
  expect((await world.audit.batches()).slice(0, batches.length)).toEqual(batches);
}, NEEDS);

scenario("IT-AUDIT-003 Org audit history is viewable by owners at no charge and immutable", async (world) => {
  const owner = person(world, "owner");
  const org = world.alias("acme");
  await world.audit.record(owner, "grant.changed", "maintainer:bob", { user_id: owner.id, scope_id: org });
  await world.audit.record(owner, "visibility.changed", "pack:gcp", { user_id: owner.id, scope_id: org });
  await world.audit.flush();
  await world.clock.advance("89d");
  const history = await world.audit.for({ scope: org });
  expect(history.map((e) => e.action).sort()).toEqual(["grant.changed", "visibility.changed"]);
  expect(await world.audit.overwriteRefused()).toBe(true);
}, NEEDS);

scenario("IT-AUDIT-004 Audit stores hashed IPs and no secrets in plain text", async (world) => {
  const alice = person(world, "alice");
  const token = "psk_live_0123456789abcdef";
  const recovery = "recovery-4f9c-a1d2";
  await world.audit.record(alice, "login", undefined, { user_id: alice.id, ip: IP });
  await world.audit.record(alice, "token.minted", "token:ci", { user_id: alice.id, ip: IP, detail: { name: "ci" } });
  // The pipeline refuses a field no action names, so a secret cannot be put in detail.
  await expect(world.audit.record(alice, "token.minted", "token:ci", { detail: { token } })).rejects.toThrow();
  await world.audit.flush();
  for (const needle of [IP, token, recovery]) expect(world.audit.scan(needle)).toEqual([]);
  const entries = await world.audit.for({ user: alice.id });
  expect(entries.every((e) => /^[0-9a-f]{64}$/.test(e.ip_hash ?? ""))).toBe(true);
  const stored = (await world.audit.batches()).flatMap((b) => b.events);
  expect(stored.every((e) => typeof e.ip_hash === "string")).toBe(true);
}, NEEDS);

scenario("IT-AUDIT-005 The record is write-once, hash-chained, anchored and verified", async (world) => {
  const sys = { kind: "system" as const };
  for (let batch = 0; batch < 3; batch++) {
    await world.audit.record(sys, "admin.action", `batch-${batch}-a`);
    await world.audit.record(sys, "admin.action", `batch-${batch}-b`);
    await world.audit.flush();
  }
  const batches = await world.audit.batches();
  expect(batches).toHaveLength(3);
  const queueIds = batches.map((b) => b.header!.message_ids);
  expect(new Set(queueIds.flat()).size).toBe(6);
  expect(batches[0]!.header!.prev_hash).toBe("0".repeat(64));

  // The nightly run comes hours after the events, so none is still in flight.
  await world.clock.advance("5h");
  const published = await world.audit.publishHead();
  expect(published.status).toBe("anchored");
  const ids = (await world.audit.batches()).flatMap((b) => b.events.map((e) => e.id));
  const last = (await world.audit.batches()).at(-1)!;
  const [served] = await world.audit.heads();
  expect(served).toMatchObject({ seq: last.header!.seq, batch_key: last.key });
  const [entry] = await world.rekor.entries();
  expect(world.rekor.signs(entry!, { seq: served!.seq, hash: served!.hash })).toBe(true);
  expect(served!.log_index).toBe(entry!.logIndex);
  expect((await world.audit.publishHead()).status).toBe("already_anchored");
  expect(await world.rekor.entries()).toHaveLength(1);

  expect(await world.audit.verify()).toBe("intact");
  expect(world.audit.alarms()).toEqual([]);

  // An id missing from the copy is a reconciliation gap.
  world.audit.forgetCopy(ids[0]!);
  const gap = await world.audit.verify();
  expect(gap).not.toBe("intact");
  expect((gap as { problems: Array<{ kind: string }> }).problems.map((p) => p.kind)).toEqual(["reconciliation"]);
  expect(world.audit.alarms()).toHaveLength(1);

  // Any changed byte is seen: at the batch itself when it no longer parses, otherwise at its successor's link.
  world.audit.tamper(1, { alter: true, offset: 400 });
  const found = await world.audit.verify();
  expect(found).not.toBe("intact");
  expect([1, 2]).toContain((found as { mismatch: { batch: number } }).mismatch.batch);
  expect(world.audit.alarms().some(([, , kind]) => kind === "chain")).toBe(true);

  // The record keeps being written while the copy's database is down.
  world.audit.outage.d1(true);
  const receipt = await world.audit.record(sys, "admin.action", "during-outage");
  expect(receipt.copy).toBe("skipped");
  await world.audit.flush();
  world.audit.outage.d1(false);
  expect((await world.audit.batches()).flatMap((b) => b.events.map((e) => e.id))).toContain(receipt.id);
}, NEEDS);

scenario("IT-AUDIT-007 Refusals are audited with a hashed source", async (world) => {
  const anon = { kind: "anonymous" as const };
  const refusals = ["signin.refused", "assertion.refused", "token.refused", "oidc.refused"] as const;
  for (const action of refusals) await world.audit.record(anon, action, undefined, { ip: IP, detail: { reason: "denied" } });
  await world.audit.flush();
  const stored = (await world.audit.batches()).flatMap((b) => b.events);
  expect(stored.map((e) => e.action).sort()).toEqual([...refusals].sort());
  expect(stored.every((e) => /^[0-9a-f]{64}$/.test(e.ip_hash ?? "") && e.detail?.["reason"] === "denied")).toBe(true);
  expect(world.audit.scan(IP)).toEqual([]);
}, NEEDS);
