import { describe, expect, it } from "vitest";
import { createFakePorts } from "@packserver/ports/fakes";
import {
  ASSERTION_TTL_MS, beginAssertion, beginAuthentication, beginRegistration, consumeGrant, credentialsOf, FAILURE_LIMIT, finishAuthentication, finishRegistration,
  HOLD_MS, holdUntilFor, FACTOR_ACTIONS, issueGrant, LOCK_MS, lockedUntil, recoveryStatus, redeemRecoveryCode, relyingPartyFor, replaceRecoveryCodes,
  saveCredential, verifyAssertion, confirmCodesSaved, recoveryHoldFor, HELD_ACTION_NAMES, type AssertionContext, type MfaPorts,
} from "../index.ts";
import { migratedD1, VirtualAuthenticator } from "../testing.ts";

const ORIGIN = "https://registry.claudinite.com";
const rp = relyingPartyFor(ORIGIN);
const MINUTE = 60_000;

function setup() {
  const fakes = createFakePorts();
  const { d1, db } = migratedD1();
  db.exec("insert into users (id, created_at) values ('u1', '2026-10-22T00:00:00.000Z'), ('u2', '2026-10-22T00:00:00.000Z')");
  const ports: MfaPorts = { d1, clock: fakes.clock, rng: fakes.rng };
  return { fakes, ports, db, device: new VirtualAuthenticator() };
}

async function enrol(ports: MfaPorts, device: VirtualAuthenticator, userId: string, hold: string | null = null) {
  const existing = await credentialsOf(ports.d1, userId);
  const options = await beginRegistration(ports, rp, { kind: "enrol", user_id: userId, user_name: userId, existing });
  const done = await finishRegistration(ports, rp, "enrol", await device.create(options, ORIGIN));
  expect(done).not.toBeNull();
  return saveCredential(ports, done!, { label: null, hold_until: hold });
}

const ctx = (over: Partial<AssertionContext> = {}): AssertionContext => ({ user_id: "u1", sid_hash: "sid-a", action: "token.mint", target: "", ...over });

async function passkeyAssertion(ports: MfaPorts, device: VirtualAuthenticator, c: AssertionContext, faults = {}) {
  const options = await beginAssertion(ports, rp, c);
  return verifyAssertion(ports, rp, c, { kind: "passkey", response: await device.get(options, ORIGIN, faults) });
}

describe("passkey ceremonies", () => {
  it("enrols a credential and signs in with it, discoverably", async () => {
    const { ports, device } = setup();
    const row = await enrol(ports, device, "u1");
    const options = await beginAuthentication(ports, rp, "signin", {});
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe("required");
    expect(options.rpId).toBe("registry.claudinite.com");
    const signedIn = await finishAuthentication(ports, rp, "signin", await device.get(options, ORIGIN));
    expect(signedIn?.credential.id).toBe(row.id);
    const [stored] = await credentialsOf(ports.d1, "u1");
    expect(stored!.sign_count).toBe(1);
  });

  it("refuses a credential made for another site, without user verification, or answering another challenge", async () => {
    const { ports, device } = setup();
    for (const faults of [{ origin: "https://evil.example" }, { unverified: true }, { challenge: "AAAA" }]) {
      const options = await beginRegistration(ports, rp, { kind: "enrol", user_id: "u1", user_name: "u1" });
      expect(await finishRegistration(ports, rp, "enrol", await device.create(options, ORIGIN, faults))).toBeNull();
    }
    expect(await credentialsOf(ports.d1, "u1")).toEqual([]);
  });

  it("answers a challenge once and only inside its lifetime", async () => {
    const { fakes, ports, device } = setup();
    await enrol(ports, device, "u1");
    const options = await beginAuthentication(ports, rp, "signin", {});
    const response = await device.get(options, ORIGIN);
    expect(await finishAuthentication(ports, rp, "signin", response)).not.toBeNull();
    expect(await finishAuthentication(ports, rp, "signin", response)).toBeNull();

    const stale = await beginAuthentication(ports, rp, "signin", {});
    fakes.clock.advance(6 * MINUTE);
    expect(await finishAuthentication(ports, rp, "signin", await device.get(stale, ORIGIN))).toBeNull();
  });

  it("refuses a forged signature", async () => {
    const { ports, device } = setup();
    await enrol(ports, device, "u1");
    const options = await beginAuthentication(ports, rp, "signin", {});
    expect(await finishAuthentication(ports, rp, "signin", await device.get(options, ORIGIN, { badSignature: true }))).toBeNull();
  });
});

describe("IT-ACC-022 an assertion is bound to its session, action and target", () => {
  it("is spent by the one request it was made for, once", async () => {
    const { ports, device } = setup();
    await enrol(ports, device, "u1");
    const c = ctx({ target: "pack-a" });
    const made = await passkeyAssertion(ports, device, c);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const token = await issueGrant(ports, c, made);

    for (const wrong of [{ sid_hash: "sid-b" }, { action: "visibility.change" }, { target: "pack-b" }]) {
      expect(await consumeGrant(ports, token, { sid_hash: c.sid_hash, action: c.action, target: c.target, ...wrong })).toBeNull();
    }
    expect(await consumeGrant(ports, token, c)).toMatchObject({ user_id: "u1", method: "passkey" });
    expect(await consumeGrant(ports, token, c)).toBeNull();
  });

  it("lets no time make a grant reusable, and expires an unspent one", async () => {
    const { fakes, ports, device } = setup();
    await enrol(ports, device, "u1");
    const made = await passkeyAssertion(ports, device, ctx());
    if (!made.ok) throw new Error("assertion failed");
    const token = await issueGrant(ports, ctx(), made);
    fakes.clock.advance(ASSERTION_TTL_MS + 1);
    expect(await consumeGrant(ports, token, ctx())).toBeNull();
  });

  it("refuses an assertion made for another action or target, or by another session", async () => {
    const { ports, device } = setup();
    await enrol(ports, device, "u1");
    for (const [asked, claimed] of [
      [ctx({ action: "yank" }), ctx({ action: "token.mint" })],
      [ctx({ target: "a" }), ctx({ target: "b" })],
      [ctx({ sid_hash: "sid-a" }), ctx({ sid_hash: "sid-b" })],
    ] as const) {
      const options = await beginAssertion(ports, rp, asked);
      const outcome = await verifyAssertion(ports, rp, claimed, { kind: "passkey", response: await device.get(options, ORIGIN) });
      expect(outcome.ok).toBe(false);
    }
  });

  it("refuses another person's credential", async () => {
    const { ports, device } = setup();
    const other = new VirtualAuthenticator();
    await enrol(ports, device, "u1");
    await enrol(ports, other, "u2");
    const options = await beginAssertion(ports, rp, ctx());
    const outcome = await verifyAssertion(ports, rp, ctx(), { kind: "passkey", response: await other.get({ ...options, allowCredentials: [] }, ORIGIN) });
    expect(outcome.ok).toBe(false);
  });
});

describe("IT-ACC-011 five failed assertions lock step-up for 15 minutes", () => {
  it("locks on the fifth failure, tells that attempt so, and refuses even a good assertion until it lapses", async () => {
    const { fakes, ports, device } = setup();
    await enrol(ports, device, "u1");
    const results = [];
    for (let i = 0; i < FAILURE_LIMIT; i++) results.push(await passkeyAssertion(ports, device, ctx(), { badSignature: true }));
    expect(results.map((r) => !r.ok && r.reason === "failed" && r.locked_now)).toEqual([false, false, false, false, true]);

    expect(await passkeyAssertion(ports, device, ctx())).toMatchObject({ ok: false, reason: "locked" });
    fakes.clock.advance(LOCK_MS - MINUTE);
    expect(await lockedUntil(ports, "u1")).not.toBeNull();
    fakes.clock.advance(MINUTE + 1);
    expect(await lockedUntil(ports, "u1")).toBeNull();
    expect((await passkeyAssertion(ports, device, ctx())).ok).toBe(true);
  });

  it("forgets failures after a success and after the window", async () => {
    const { fakes, ports, device } = setup();
    await enrol(ports, device, "u1");
    for (let i = 0; i < FAILURE_LIMIT - 1; i++) await passkeyAssertion(ports, device, ctx(), { badSignature: true });
    expect((await passkeyAssertion(ports, device, ctx())).ok).toBe(true);
    for (let i = 0; i < FAILURE_LIMIT - 1; i++) await passkeyAssertion(ports, device, ctx(), { badSignature: true });
    fakes.clock.advance(16 * MINUTE);
    expect(await passkeyAssertion(ports, device, ctx(), { badSignature: true })).toMatchObject({ ok: false, locked_now: false });
    expect(await lockedUntil(ports, "u1")).toBeNull();
  });

  it("counts wrong recovery codes like wrong assertions", async () => {
    const { ports, device } = setup();
    await enrol(ports, device, "u1");
    await replaceRecoveryCodes(ports, "u1");
    const outcomes = [];
    for (let i = 0; i < FAILURE_LIMIT + 1; i++) outcomes.push(await verifyAssertion(ports, rp, ctx(), { kind: "recovery", code: `aaaaa-aaaa${i}` }));
    expect(outcomes.map((o) => (o.ok ? "ok" : o.reason))).toEqual(["failed", "failed", "failed", "failed", "failed", "locked"]);
  });
});

describe("recovery codes", () => {
  it("makes ten distinct codes, keeps only hashes and spends each once", async () => {
    const { ports, db } = setup();
    const codes = await replaceRecoveryCodes(ports, "u1");
    expect(new Set(codes).size).toBe(10);
    expect(JSON.stringify(db.prepare("select * from recovery_codes").all())).not.toContain(codes[0]!);
    expect(await redeemRecoveryCode(ports, "u1", codes[0]!)).toBe(true);
    expect(await redeemRecoveryCode(ports, "u1", codes[0]!)).toBe(false);
    expect(await redeemRecoveryCode(ports, "u1", codes[1]!.toUpperCase().replace("-", " "))).toBe(true);
    expect(await redeemRecoveryCode(ports, "u2", codes[2]!)).toBe(false);
    expect(await recoveryStatus(ports.d1, "u1")).toEqual({ has_codes: true, saved: false, remaining: 8 });
  });

  it("replaces the old set and resets the reminder", async () => {
    const { ports } = setup();
    const first = await replaceRecoveryCodes(ports, "u1");
    await confirmCodesSaved(ports, "u1");
    expect(await recoveryStatus(ports.d1, "u1")).toMatchObject({ saved: true });
    const second = await replaceRecoveryCodes(ports, "u1");
    expect(await redeemRecoveryCode(ports, "u1", first[2]!)).toBe(false);
    expect(await redeemRecoveryCode(ports, "u1", second[2]!)).toBe(true);
    expect(await recoveryStatus(ports.d1, "u1")).toMatchObject({ saved: false });
  });
});

describe("IT-ACC-005 a new factor on a publishing account is on hold unless a passkey confirmed it", () => {
  const publishing = (db: ReturnType<typeof setup>["db"]) => {
    db.exec("insert into scopes (id, name, kind, created_at) values ('s1', 'acme', 'org', '2026-10-22T00:00:00.000Z')");
    db.exec("insert into scope_members (scope_id, user_id, role, created_at) values ('s1', 'u1', 'owner', '2026-10-22T00:00:00.000Z')");
  };

  it("holds a factor confirmed by a recovery code, not one confirmed by an unheld passkey, and none on an account that cannot publish", async () => {
    const { ports, device, db } = setup();
    const first = await enrol(ports, device, "u1");
    expect(await holdUntilFor(ports, "u1", null)).toBeNull();
    publishing(db);

    const byPasskey = { user_id: "u1", method: "passkey" as const, credential_id: first.id };
    expect(await holdUntilFor(ports, "u1", byPasskey)).toBeNull();
    const held = await holdUntilFor(ports, "u1", { user_id: "u1", method: "recovery", credential_id: null });
    expect(Date.parse(held!) - ports.clock.now()).toBe(HOLD_MS);

    const k2 = await enrol(ports, new VirtualAuthenticator(), "u1", held);
    expect(await holdUntilFor(ports, "u1", { user_id: "u1", method: "passkey", credential_id: k2.id })).not.toBeNull();
  });

  it("keeps a held factor out of the held actions until the hold lapses, and in the other actions at once", async () => {
    const { fakes, ports, device, db } = setup();
    publishing(db);
    const held = isoAtOffset(ports, HOLD_MS);
    await enrol(ports, device, "u1", held);

    const approve = ctx({ action: "publish.approve", target: "v1" });
    expect(await beginAssertion(ports, rp, approve)).toMatchObject({ allowCredentials: [] });
    expect((await passkeyAssertion(ports, device, ctx())).ok).toBe(true);
    const options = await beginAssertion(ports, rp, approve);
    options.allowCredentials = [];
    expect((await verifyAssertion(ports, rp, approve, { kind: "passkey", response: await device.get(options, ORIGIN) })).ok).toBe(false);

    fakes.clock.advance(HOLD_MS + MINUTE);
    expect((await passkeyAssertion(ports, device, approve)).ok).toBe(true);
  });
});

describe("IT-ACC-005 a held factor cannot launder its hold through recovery codes", () => {
  const setupHeld = async () => {
    const world = setup();
    const { ports, device, db } = world;
    const k1 = await enrol(ports, device, "u1");
    db.exec("insert into scopes (id, name, kind, created_at) values ('s1', 'acme', 'org', '2026-10-22T00:00:00.000Z')");
    db.exec("insert into scope_members (scope_id, user_id, role, created_at) values ('s1', 'u1', 'owner', '2026-10-22T00:00:00.000Z')");
    const held = await holdUntilFor(ports, "u1", { user_id: "u1", method: "recovery", credential_id: null });
    const k2 = await enrol(ports, new VirtualAuthenticator(), "u1", held);
    return { ...world, k1, k2, held };
  };
  const approve = ctx({ action: HELD_ACTION_NAMES.publishApprove, target: "v1" });
  const byCode = (ports: MfaPorts, code: string, c = approve) => verifyAssertion(ports, rp, c, { kind: "recovery", code });

  it("gives a code set regenerated under a held passkey that passkey's hold", async () => {
    const { ports, fakes, k2, held } = await setupHeld();
    const hold = await recoveryHoldFor(ports, "u1", { user_id: "u1", method: "passkey", credential_id: k2.id });
    expect(hold).toBe(held);
    const codes = await replaceRecoveryCodes(ports, "u1", hold);

    expect((await byCode(ports, codes[0]!)).ok).toBe(false);
    expect((await byCode(ports, codes[0]!, ctx({ action: "token.mint" }))).ok).toBe(true);
    fakes.clock.advance(HOLD_MS + MINUTE);
    expect((await byCode(ports, codes[1]!)).ok).toBe(true);
  });

  it("carries the hold through a regeneration confirmed by a held code, and none through an unheld one", async () => {
    const { ports, k1, k2 } = await setupHeld();
    const heldCodes = await replaceRecoveryCodes(ports, "u1", await recoveryHoldFor(ports, "u1", { user_id: "u1", method: "passkey", credential_id: k2.id }));
    expect(await byCode(ports, heldCodes[0]!, ctx({ action: FACTOR_ACTIONS.regenerateCodes }))).toMatchObject({ ok: true });
    const again = await recoveryHoldFor(ports, "u1", { user_id: "u1", method: "recovery", credential_id: null });
    expect(again).not.toBeNull();

    const clean = await replaceRecoveryCodes(ports, "u1", await recoveryHoldFor(ports, "u1", { user_id: "u1", method: "passkey", credential_id: k1.id }));
    expect((await byCode(ports, clean[0]!)).ok).toBe(true);
    expect(await recoveryHoldFor(ports, "u1", { user_id: "u1", method: "recovery", credential_id: null })).toBeNull();
  });

  it("does not spend a code the hold refused", async () => {
    const { ports, k2 } = await setupHeld();
    const codes = await replaceRecoveryCodes(ports, "u1", await recoveryHoldFor(ports, "u1", { user_id: "u1", method: "passkey", credential_id: k2.id }));
    expect((await byCode(ports, codes[0]!)).ok).toBe(false);
    expect((await byCode(ports, codes[0]!, ctx({ action: "token.mint" }))).ok).toBe(true);
  });
});

const isoAtOffset = (ports: MfaPorts, ms: number) => new Date(ports.clock.now() + ms).toISOString();
