import { describe, expect, it } from "vitest";
import { createFakePorts } from "@packserver/ports/fakes";
import {
  approveRecovery, completeRecovery, createSession, deleteAccount, lacksRequiredFactor, linkGitHub, noteSignInDevice, publishingFrozen, RECOVERY_DELAY_MS,
  requestRecovery, RECOVERY_APPROVAL_TTL_MS, cancelRecoveries, cancelRecoveryByToken, checkDeletable, revokeSession, setScopeMfaPolicy, isRevoked,
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
    expect(await publishingFrozen(ports, "s1")).toBe(true);
    expect(await publishingFrozen(ports, "o1")).toBe(true);

    const id = (opened as { id: string }).id;
    fakes.clock.advance(RECOVERY_DELAY_MS - HOUR);
    expect(await approveRecovery(ports, id, "admin@example.test")).toMatchObject({ ok: false, reason: "too_early" });
    fakes.clock.advance(HOUR);
    expect(await approveRecovery(ports, id, "admin@example.test")).toEqual({ ok: true, user_id: "u1" });
    expect(await approveRecovery(ports, id, "admin@example.test")).toMatchObject({ ok: false, reason: "not_pending" });
    expect(await publishingFrozen(ports, "s1")).toBe(true);

    const link = await requestRecovery(ports, "a@example.test");
    expect(link).toMatchObject({ kind: "link", email: "a@example.test" });
    const token = (link as { token: string }).token;
    expect(await completeRecovery(ports, "wrong")).toBeNull();
    expect(await completeRecovery(ports, token)).toEqual({ user_id: "u1" });
    expect(await completeRecovery(ports, token)).toBeNull();
    expect(await publishingFrozen(ports, "s1")).toBe(false);
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

describe("recovery that can be stopped and re-checked", () => {
  const open = async (t: ReturnType<typeof setup>) => {
    const opened = (await requestRecovery(t.ports, "a@example.test")) as { id: string; cancel_token: string };
    return opened;
  };
  const passkey = (t: ReturnType<typeof setup>) =>
    t.db.exec(`insert into credentials (id, user_id, credential_id, public_key, created_at) values ('c9', 'u1', 'cid9', 'pk', '${NOW}')`);

  it("stops with the one-time link, once, and lifts the freeze", async () => {
    const t = setup();
    const { cancel_token } = await open(t);
    expect(await publishingFrozen(t.ports, "s1")).toBe(true);
    expect(await cancelRecoveryByToken(t.ports, "nope")).toBeNull();
    expect(await cancelRecoveryByToken(t.ports, cancel_token)).toEqual({ user_id: "u1" });
    expect(await cancelRecoveryByToken(t.ports, cancel_token)).toBeNull();
    expect(await publishingFrozen(t.ports, "s1")).toBe(false);
  });

  it("is cancelled for the signed-in person", async () => {
    const t = setup();
    await open(t);
    expect(await cancelRecoveries(t.ports, "u1")).toBe(1);
    expect(await publishingFrozen(t.ports, "s1")).toBe(false);
  });

  it("is refused at approval once a passkey exists, and the request is cancelled", async () => {
    const t = setup();
    const { id } = await open(t);
    passkey(t);
    t.fakes.clock.advance(RECOVERY_DELAY_MS);
    expect(await approveRecovery(t.ports, id, "admin")).toEqual({ ok: false, reason: "no_longer_eligible" });
    expect(await publishingFrozen(t.ports, "s1")).toBe(false);
  });

  it("is refused at completion once a provider is linked after the link was mailed", async () => {
    const t = setup();
    const { id } = await open(t);
    t.fakes.clock.advance(RECOVERY_DELAY_MS);
    await approveRecovery(t.ports, id, "admin");
    const link = (await requestRecovery(t.ports, "a@example.test")) as { token: string };
    t.db.exec(`insert into identities (id, user_id, provider, provider_user_id, created_at) values ('i9', 'u1', 'github', '99', '${NOW}')`);
    expect(await completeRecovery(t.ports, link.token)).toBeNull();
  });

  it("lapses seven days after approval and the freeze lifts with it", async () => {
    const t = setup();
    const { id } = await open(t);
    t.fakes.clock.advance(RECOVERY_DELAY_MS);
    await approveRecovery(t.ports, id, "admin");
    t.fakes.clock.advance(RECOVERY_APPROVAL_TTL_MS - HOUR);
    expect(await publishingFrozen(t.ports, "s1")).toBe(true);
    const link = (await requestRecovery(t.ports, "a@example.test")) as { token: string };
    t.fakes.clock.advance(2 * HOUR);
    expect(await publishingFrozen(t.ports, "s1")).toBe(false);
    expect(await completeRecovery(t.ports, link.token)).toBeNull();
    expect(await requestRecovery(t.ports, "a@example.test")).toMatchObject({ kind: "opened" });
  });

  it("audits the opening and the approval before they are written", async () => {
    const t = setup();
    const seen: number[] = [];
    const count = () => Number((t.db.prepare("select count(*) as n from recovery_requests").get() as { n: number }).n);
    const opened = (await requestRecovery(t.ports, "a@example.test", async () => void seen.push(count()))) as { id: string };
    t.fakes.clock.advance(RECOVERY_DELAY_MS);
    const state = () => (t.db.prepare("select state from recovery_requests").get() as { state: string }).state;
    await approveRecovery(t.ports, opened.id, "admin", async () => void seen.push(state() === "pending" ? -1 : -2));
    expect(seen).toEqual([0, -1]);
  });

  const stateOf = (t: ReturnType<typeof setup>) => (t.db.prepare("select state from recovery_requests").get() as { state: string }).state;
  const failing = async () => {
    throw new Error("audit queue down");
  };

  it("writes nothing when the approval's audit fails, and the request can still be approved", async () => {
    const t = setup();
    const { id } = await open(t);
    t.fakes.clock.advance(RECOVERY_DELAY_MS);
    await expect(approveRecovery(t.ports, id, "admin", failing)).rejects.toThrow("audit queue down");
    expect(stateOf(t)).toBe("pending");
    expect(await approveRecovery(t.ports, id, "admin")).toEqual({ ok: true, user_id: "u1" });
  });

  it("writes nothing when the completion's audit fails, and the link still works", async () => {
    const t = setup();
    const { id } = await open(t);
    t.fakes.clock.advance(RECOVERY_DELAY_MS);
    await approveRecovery(t.ports, id, "admin");
    const link = (await requestRecovery(t.ports, "a@example.test")) as { token: string };
    await expect(completeRecovery(t.ports, link.token, failing)).rejects.toThrow("audit queue down");
    expect(stateOf(t)).toBe("approved");
    expect(await completeRecovery(t.ports, link.token)).toEqual({ user_id: "u1" });
  });

  it("writes nothing when the cancel's audit fails, audits only an open recovery, and can be retried", async () => {
    const t = setup();
    const audited: string[] = [];
    expect(await cancelRecoveries(t.ports, "u1", async (u) => void audited.push(u))).toBe(0);
    expect(audited).toEqual([]);
    await open(t);
    await expect(cancelRecoveries(t.ports, "u1", failing)).rejects.toThrow("audit queue down");
    expect(stateOf(t)).toBe("pending");
    expect(await cancelRecoveries(t.ports, "u1", async (u) => void audited.push(u))).toBe(1);
    expect(audited).toEqual(["u1"]);
  });

  /** Lets a passkey land between the check and the conditional update, as a second request could. */
  const racing = (t: ReturnType<typeof setup>, update: RegExp) => ({
    ...t.ports,
    d1: {
      ...t.ports.d1,
      query: (sql: string, params?: unknown[]) => {
        if (update.test(sql)) passkey(t);
        return t.ports.d1.query(sql, params);
      },
      batch: (statements: Parameters<typeof t.ports.d1.batch>[0]) => t.ports.d1.batch(statements),
    } as typeof t.ports.d1,
  });

  it("refuses an approval that loses the race to a new passkey", async () => {
    const t = setup();
    const { id } = await open(t);
    t.fakes.clock.advance(RECOVERY_DELAY_MS);
    const audited: string[] = [];
    const result = await approveRecovery(racing(t, /set state = 'approved'/), id, "admin", async (u) => void audited.push(u));
    expect(result).toEqual({ ok: false, reason: "no_longer_eligible" });
    expect(audited).toEqual(["u1"]);
    expect(stateOf(t)).toBe("pending");
  });

  it("refuses a completion that loses the race to a new passkey", async () => {
    const t = setup();
    const { id } = await open(t);
    t.fakes.clock.advance(RECOVERY_DELAY_MS);
    await approveRecovery(t.ports, id, "admin");
    const link = (await requestRecovery(t.ports, "a@example.test")) as { token: string };
    const audited: string[] = [];
    expect(await completeRecovery(racing(t, /set state = 'completed'/), link.token, async (u) => void audited.push(u))).toBeNull();
    expect(audited).toEqual(["u1"]);
    expect(stateOf(t)).toBe("approved");
  });
});

describe("audit before the revocation", () => {
  it("runs the hook while the session still stands", async () => {
    const { ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device: { label: "x", country: "NO" } });
    let revokedDuring: boolean | undefined;
    await revokeSession(ports, "u1", live.sid_hash, async () => void (revokedDuring = await isRevoked(ports, live.sid_hash)));
    expect(revokedDuring).toBe(false);
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
  it("removes trusted publishers of the personal scope, pending ones and the credentials that name them included", async () => {
    const { ports, db } = setup();
    db.exec(`insert into scopes (id, name, kind, state, created_at) values ('s2', 'bob', 'user', 'active', '${NOW}')`);
    db.exec(`insert into scope_members (scope_id, user_id, role, created_at) values ('s2', 'u2', 'owner', '${NOW}')`);
    db.exec(`insert into trusted_publishers (id, scope_id, pack_name, repository_id, repository_owner_id, repository, workflow, path, refs, events, pending_until, created_at, updated_at)
             values ('tp1', 's1', 'gcp', '1', '2', 'ann/gcp', 'w.yml', 'p', '[]', '[]', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}'),
                    ('tp2', 'o1', 'org-pack', '1', '2', 'acme/x', 'w.yml', 'p', '[]', '[]', null, '${NOW}', '${NOW}'),
                    ('tp3', 's2', 'bob-pack', '1', '2', 'bob/x', 'w.yml', 'p', '[]', '[]', null, '${NOW}', '${NOW}')`);
    db.exec(`insert into upload_credentials (id, secret_hash, source, scope_id, pack_name, version, trusted_publisher_id, staging_key, lifetime, issued_at, expires_at)
             values ('uc1', 'h', 'oidc', 's1', 'gcp', '1.0.0', 'tp1', 'k', 'draft', '${NOW}', '${NOW}')`);
    expect(await checkDeletable(ports.d1, "u1")).toMatchObject({ ok: false });
    db.exec("delete from scope_members where scope_id = 'o1' and user_id = 'u1'");
    db.exec(`insert into scope_members (scope_id, user_id, role, created_at) values ('o1', 'u2', 'owner', '${NOW}') on conflict do update set role = 'owner'`);
    expect(await deleteAccount(ports, "u1")).toEqual({ ok: true });
    expect(db.prepare("select id from trusted_publishers").all()).toEqual([{ id: "tp2" }, { id: "tp3" }]);
    expect(db.prepare("select trusted_publisher_id as t from upload_credentials").get()).toEqual({ t: null });
  });

  it("keeps the handle, removes every way in and the credential flags, and refuses a sole owner", async () => {
    const { ports, db } = setup();
    db.exec(`insert into credentials (id, user_id, credential_id, public_key, created_at) values ('c1', 'u2', 'cid', 'pk', '${NOW}')`);
    db.exec("insert into credential_flags (credential_id, hold_until) values ('c1', null)");
    db.exec(`insert into identities (id, user_id, provider, provider_user_id, created_at) values ('i1', 'u2', 'github', '9', '${NOW}')`);
    db.exec(`insert into device_codes (device_hash, user_code_hash, state, country, created_at, expires_at, interval_s, user_id)
             values ('d1', 'uc1', 'approved', 'IL', 1, 2, 5, 'u2'), ('d2', 'uc2', 'pending', 'IL', 1, 2, 5, null), ('d3', 'uc3', 'approved', 'IL', 1, 2, 5, 'u1')`);
    db.exec(`insert into device_tokens (token_hash, user_id, sid_hash, created_at, expires_at) values ('t1', 'u2', 's', 1, 2), ('t2', 'u1', 's', 1, 2)`);

    expect(await deleteAccount(ports, "u1")).toEqual({ ok: false, reason: "sole_owner", orgs: ["acme"] });
    expect(await deleteAccount(ports, "u2")).toEqual({ ok: true });
    for (const table of ["credentials", "credential_flags", "identities", "device_codes", "device_tokens"]) {
      expect(db.prepare(`select count(*) as n from ${table} where ${table === "credential_flags" ? "credential_id" : "user_id"} in ('c1', 'u2')`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare("select device_hash from device_codes order by device_hash").all()).toEqual([{ device_hash: "d2" }, { device_hash: "d3" }]);
    expect(db.prepare("select token_hash from device_tokens").all()).toEqual([{ token_hash: "t2" }]);
    expect(db.prepare("select handle from users where id = 'u2'").get()).toEqual({ handle: "bob" });
    expect(db.prepare("select name from retired_names where kind = 'scope'").all()).toEqual([{ name: "bob" }]);
    expect(db.prepare("select count(*) as n from user_emails where user_id = 'u2'").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from account_tombstones").get()).toEqual({ n: 1 });
  });
});
