import { describe, expect, it } from "vitest";
import { migratedD1 } from "../../identity/testing.ts";
import {
  PENDING_CAP, PENDING_NAME_MS, changePublisher, hasPublisherChange, listPublishers, normalizePublisher, ownerAddresses, registerPublisher, setTrustedOnly,
  settlePending, webUploadGate, type PublisherInput, type TrustedPorts,
} from "../index.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const INPUT: PublisherInput = { repository: "acme/packs", repository_id: "5150", repository_owner_id: "1001", workflow: ".github/workflows/publish.yml", environment: "release", path: "packs/gcp" };

function setup() {
  const { d1, db } = migratedD1();
  let now = NOW;
  const ports: TrustedPorts = {
    d1,
    clock: { now: () => now },
    rng: { float: () => 0.5, uuid: () => crypto.randomUUID(), bytes: (len) => crypto.getRandomValues(new Uint8Array(len)) },
  };
  const at = new Date(NOW).toISOString();
  db.exec(`insert into users (id, handle, created_at) values ('u1', 'p', '${at}'), ('u2', 'q', '${at}'), ('u3', 'm', '${at}')`);
  db.exec(`insert into scopes (id, name, kind, state, created_at) values ('s1', 'acme', 'org', 'active', '${at}')`);
  db.exec(`insert into scope_members (scope_id, user_id, role, created_at) values ('s1', 'u1', 'owner', '${at}'), ('s1', 'u2', 'owner', '${at}'), ('s1', 'u3', 'maintainer', '${at}')`);
  db.exec(`insert into user_emails (user_id, address, source, created_at) values ('u1', 'p@x.test', 'github', '${at}'), ('u2', 'q@x.test', 'github', '${at}'), ('u3', 'm@x.test', 'github', '${at}')`);
  const scope = { id: "s1", name: "acme" };
  const register = (packName: string, input: Partial<PublisherInput> = {}) => registerPublisher(ports, { scope, packName, userId: "u1", input: { ...INPUT, ...input } });
  return { ports, db, d1, scope, register, advance: (ms: number) => (now += ms), at };
}

describe("normalizePublisher", () => {
  it("fills the default refs and events and refuses what cannot be matched safely", () => {
    const ok = normalizePublisher(INPUT, "gcp");
    expect(ok).toMatchObject({ ok: true, value: { refs: ["refs/tags/gcp/*", "refs/heads/main"], events: ["push", "release", "workflow_dispatch"], environment: "release" } });
    expect(normalizePublisher({ ...INPUT, repository: "acme" }, "gcp")).toMatchObject({ ok: false });
    expect(normalizePublisher({ ...INPUT, repository_id: "abc" }, "gcp")).toMatchObject({ ok: false });
    expect(normalizePublisher({ ...INPUT, workflow: "../x.yml" }, "gcp")).toMatchObject({ ok: false });
    for (const event of ["pull_request_target", "issue_comment", "schedule"]) expect(normalizePublisher({ ...INPUT, events: [event] }, "gcp")).toMatchObject({ ok: false });
    expect(normalizePublisher({ ...INPUT, refs: ["main"] }, "gcp")).toMatchObject({ ok: false });
  });
});

describe("registerPublisher (REQ-PUB-001)", () => {
  it("reserves a pending name for 14 days and lets it lapse", async () => {
    const t = setup();
    const out = await t.register("new");
    expect(out).toMatchObject({ ok: true, publisher: { pack: "new", pending_until: new Date(NOW + PENDING_NAME_MS).toISOString() } });
    expect((await webUploadGate(t.ports, "s1", "new")).ok).toBe(false);
    t.advance(PENDING_NAME_MS + 3_600_000);
    expect(await listPublishers(t.ports, "s1", "new")).toEqual([]);
    expect(await webUploadGate(t.ports, "s1", "new")).toEqual({ ok: true });
  });

  it("holds a scope to ten pending registrations, and only pending ones count", async () => {
    const t = setup();
    t.db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('pk', 's1', 'real', 'public', '${t.at}')`);
    for (let i = 0; i < PENDING_CAP; i++) expect(await t.register(`p${i}`)).toMatchObject({ ok: true });
    expect(await t.register("p10")).toMatchObject({ ok: false, reason: "cap" });
    expect(await t.register("real")).toMatchObject({ ok: true, publisher: { pending_until: null } });
    t.advance(PENDING_NAME_MS + 1);
    expect(await t.register("p10")).toMatchObject({ ok: true });
  });

  it("never deletes the registration of a pack that exists, even with a stale pending date", async () => {
    const t = setup();
    t.db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('pk', 's1', 'real', 'public', '${t.at}')`);
    t.db.exec(`insert into trusted_publishers (id, scope_id, pack_name, repository_id, repository_owner_id, repository, workflow, path, refs, events, pending_until, created_at, updated_at)
      values ('old', 's1', 'real', '1', '1', 'a/b', 'w.yml', 'p', '[]', '[]', '2020-01-01T00:00:00.000Z', '${t.at}', '${t.at}')`);
    await t.register("other");
    expect(t.db.prepare("select 1 from trusted_publishers where id = 'old'").all()).toHaveLength(1);
  });

  it("refuses the same repository, workflow, environment and path twice", async () => {
    const t = setup();
    await t.register("new");
    expect(await t.register("new")).toMatchObject({ ok: false, reason: "exists" });
    expect(await t.register("new", { environment: null })).toMatchObject({ ok: true });
  });

  it("settles a pending registration when the pack is promoted", async () => {
    const t = setup();
    await t.register("new");
    await settlePending(t.d1, "s1", "new");
    t.advance(PENDING_NAME_MS * 2);
    expect(await listPublishers(t.ports, "s1", "new")).toHaveLength(1);
  });

  it("emits a publisher-change event for the validator", async () => {
    const t = setup();
    expect(await hasPublisherChange(t.d1, "s1", "new")).toBe(false);
    await t.register("new");
    expect(await hasPublisherChange(t.d1, "s1", "new")).toBe(true);
    expect(await hasPublisherChange(t.d1, "s1", "other")).toBe(false);
  });
});

describe("changePublisher (REQ-PUB-002)", () => {
  it("applies the patch to the named registration and emits an event", async () => {
    const t = setup();
    const added = await t.register("new");
    if (!added.ok) throw new Error("setup");
    t.db.exec("update publisher_changes set consumed_at = '2026-10-24T00:00:00.000Z'");
    expect(await hasPublisherChange(t.d1, "s1", "new")).toBe(false);
    const out = await changePublisher(t.ports, { scope: t.scope, packName: "new", userId: "u1", id: added.publisher.id, patch: { workflow: ".github/workflows/release.yml" } });
    expect(out).toMatchObject({ ok: true, before: { workflow: INPUT.workflow }, publisher: { workflow: ".github/workflows/release.yml", environment: "release" } });
    expect(await hasPublisherChange(t.d1, "s1", "new")).toBe(true);
    expect(await changePublisher(t.ports, { scope: t.scope, packName: "other", userId: "u1", id: added.publisher.id, patch: {} })).toMatchObject({ ok: false, reason: "not-found" });
    expect(await changePublisher(t.ports, { scope: t.scope, packName: "new", userId: "u1", id: added.publisher.id, patch: { workflow: "/etc" } })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("webUploadGate and owners", () => {
  it("refuses web uploads of a trusted-only pack and nothing else", async () => {
    const t = setup();
    t.db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('pk', 's1', 'real', 'public', '${t.at}')`);
    expect(await webUploadGate(t.ports, "s1", "real")).toEqual({ ok: true });
    expect(await setTrustedOnly(t.ports, "s1", "real", true)).toBe(true);
    expect(await webUploadGate(t.ports, "s1", "real")).toMatchObject({ ok: false, reason: "trusted-only" });
    expect(await setTrustedOnly(t.ports, "s1", "missing", true)).toBe(false);
  });

  it("lists owners' addresses, not maintainers'", async () => {
    const t = setup();
    expect(await ownerAddresses(t.d1, "s1")).toEqual(["p@x.test", "q@x.test"]);
  });
});
