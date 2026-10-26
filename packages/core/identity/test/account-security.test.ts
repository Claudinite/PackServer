import { describe, expect, it } from "vitest";
import { createFakePorts } from "@packserver/ports/fakes";
import {
  approveRecovery, completeRecovery, createSession, deleteAccount, lacksRequiredFactor, linkGitHub, noteSignInDevice, publishingFrozen, RECOVERY_DELAY_MS,
  requestRecovery, revokeSession, setScopeMfaPolicy, isRevoked,
} from "../index.ts";
import { migratedD1 } from "../testing.ts";

const HOUR = 3_600_000;
const NOW = "2026-10-22T00:00:00.000Z";

function setup() {
  const fakes = createFakePorts();
  const { d1, db } = migratedD1();
  db.exec(`insert into users (id, handle, created_at) values ('u1', 'ann', '${NOW}'), ('u2', 'bob', '${NOW}')`);
  db.exec(`insert into user_emails (user_id, address, source, created_at) values ('u1', 'a@example.test', 'github', '${NOW}'), ('u1', 'a2@example.test', 'github', '${NOW}'), ('u2', 'b@example.test', 'github', '${NOW}')`);
  db.exec(`insert into scopes (id, name, kind, state, created_at) values ('s1', 'ann', 'user', 'active', '${NOW}'), ('o1', 'acme', 'org', 'active', '${NOW}')`);
  db.exec(`insert into scope_members (scope_id, user_id, role, created_at) values ('s1', 'u1', 'owner', '${NOW}'), ('o1', 'u1', 'owner', '${NOW}'), ('o1', 'u2', 'maintainer', '${NOW}')`);
  return { fakes, d1, db, ports: { d1, clock: fakes.clock, rng: fakes.rng, kv: fakes.kv.SESSIONS_KV! } };
}

describe("devices", () => {
  it("notes a first sign-in quietly, a repeat quietly and another device as new", async () => {
    const { d1, fakes } = setup();
    const a = { label: "Firefox on Linux", country: "NO" };
    expect(await noteSignInDevice({ d1, clock: fakes.clock }, "u1", a)).toEqual({ isNew: false });
    expect(await noteSignInDevice({ d1, clock: fakes.clock }, "u1", a)).toEqual({ isNew: false });
    expect(await noteSignInDevice({ d1, clock: fakes.clock }, "u1", { label: "Chrome on macOS", country: "SE" })).toEqual({ isNew: true });
  });
});

describe("revocation", () => {
  it("ends the person's own session at once and refuses another person's", async () => {
    const { ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device: { label: "x", country: "NO" } });
    expect(await revokeSession(ports, "u2", live.sid_hash)).toBe(false);
    expect(await isRevoked(ports, live.sid_hash)).toBe(false);
    expect(await revokeSession(ports, "u1", live.sid_hash)).toBe(true);
    expect(await isRevoked(ports, live.sid_hash)).toBe(true);
    expect(await revokeSession(ports, "u1", live.sid_hash)).toBe(false);
  });
});

describe("scope MFA policy", () => {
  it("asks a person without a passkey only when the scope requires one", async () => {
    const { d1, fakes, db } = setup();
    expect(await lacksRequiredFactor(d1, "o1", "u2")).toBe(false);
    await setScopeMfaPolicy({ d1, clock: fakes.clock }, "o1", "mfa", "u1");
    expect(await lacksRequiredFactor(d1, "o1", "u2")).toBe(true);
    expect(await lacksRequiredFactor(d1, "s1", "u2")).toBe(false);
    db.exec(`insert into credentials (id, user_id, credential_id, public_key, created_at) values ('c1', 'u2', 'cid', 'pk', '${NOW}')`);
    expect(await lacksRequiredFactor(d1, "o1", "u2")).toBe(false);
    await setScopeMfaPolicy({ d1, clock: fakes.clock }, "o1", "passkey", "u1");
    expect(await lacksRequiredFactor(d1, "o1", "u2")).toBe(false);
  });
});

describe("delayed recovery", () => {
  it("opens only for an account with nothing left, waits 72 hours and then needs an approval and a link", async () => {
    const { ports, fakes, db } = setup();
    expect(await requestRecovery(ports, "nobody@example.test")).toEqual({ kind: "ignored" });
    db.exec(`insert into identities (id, user_id, provider, provider_user_id, created_at) values ('i1', 'u2', 'github', '9', '${NOW}')`);
    expect(await requestRecovery(ports, "b@example.test")).toEqual({ kind: "ignored" });

    const opened = await requestRecovery(ports, "A2@example.test");
    expect(opened).toMatchObject({ kind: "opened", user_id: "u1", addresses: ["a2@example.test", "a@example.test"] });
    expect(await requestRecovery(ports, "a@example.test")).toEqual({ kind: "ignored" });
    expect(await publishingFrozen(ports.d1, "s1")).toBe(true);
    expect(await publishingFrozen(ports.d1, "o1")).toBe(true);

    const id = (opened as { id: string }).id;
    fakes.clock.advance(RECOVERY_DELAY_MS - HOUR);
    expect(await approveRecovery(ports, id, "admin@example.test")).toMatchObject({ ok: false, reason: "too_early" });
    fakes.clock.advance(HOUR);
    expect(await approveRecovery(ports, id, "admin@example.test")).toEqual({ ok: true, user_id: "u1" });
    expect(await approveRecovery(ports, id, "admin@example.test")).toMatchObject({ ok: false, reason: "not_pending" });
    expect(await publishingFrozen(ports.d1, "s1")).toBe(true);

    const link = await requestRecovery(ports, "a@example.test");
    expect(link).toMatchObject({ kind: "link", email: "a@example.test" });
    const token = (link as { token: string }).token;
    expect(await completeRecovery(ports, "wrong")).toBeNull();
    expect(await completeRecovery(ports, token)).toEqual({ user_id: "u1" });
    expect(await completeRecovery(ports, token)).toBeNull();
    expect(await publishingFrozen(ports.d1, "s1")).toBe(false);
  });

  it("lets a link lapse", async () => {
    const { ports, fakes } = setup();
    const opened = await requestRecovery(ports, "a@example.test");
    fakes.clock.advance(RECOVERY_DELAY_MS);
    await approveRecovery(ports, (opened as { id: string }).id, "admin");
    const link = await requestRecovery(ports, "a@example.test");
    fakes.clock.advance(25 * HOUR);
    expect(await completeRecovery(ports, (link as { token: string }).token)).toBeNull();
  });
});

describe("linking", () => {
  it("adds an identity once and never takes one from another account", async () => {
    const { d1, fakes, db } = setup();
    const profile = { id: "77", login: "ann-gh", name: null, emails: [], adminOrgs: [] };
    expect(await linkGitHub({ d1, clock: fakes.clock, rng: fakes.rng }, "u1", profile)).toEqual({ ok: true, created: true });
    expect(await linkGitHub({ d1, clock: fakes.clock, rng: fakes.rng }, "u1", profile)).toEqual({ ok: true, created: false });
    expect(await linkGitHub({ d1, clock: fakes.clock, rng: fakes.rng }, "u2", profile)).toEqual({ ok: false, reason: "taken" });
    expect(db.prepare("select count(*) as n from identities").get()).toEqual({ n: 1 });
  });
});

describe("deletion", () => {
  it("keeps the handle, removes every way in and the credential flags, and refuses a sole owner", async () => {
    const { ports, db } = setup();
    db.exec(`insert into credentials (id, user_id, credential_id, public_key, created_at) values ('c1', 'u2', 'cid', 'pk', '${NOW}')`);
    db.exec("insert into credential_flags (credential_id, hold_until) values ('c1', null)");
    db.exec(`insert into identities (id, user_id, provider, provider_user_id, created_at) values ('i1', 'u2', 'github', '9', '${NOW}')`);

    expect(await deleteAccount(ports, "u1")).toEqual({ ok: false, reason: "sole_owner", orgs: ["acme"] });
    expect(await deleteAccount(ports, "u2")).toEqual({ ok: true });
    for (const table of ["credentials", "credential_flags", "identities"]) {
      expect(db.prepare(`select count(*) as n from ${table} where ${table === "credential_flags" ? "credential_id" : "user_id"} in ('c1', 'u2')`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare("select handle from users where id = 'u2'").get()).toEqual({ handle: "bob" });
    expect(db.prepare("select name from retired_names where kind = 'scope'").all()).toEqual([{ name: "bob" }]);
    expect(db.prepare("select count(*) as n from user_emails where user_id = 'u2'").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from account_tombstones").get()).toEqual({ n: 1 });
  });
});
