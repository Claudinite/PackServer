import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { migratedD1 } from "../../identity/testing.ts";
import { inCidr, parseCidr } from "../cidr.ts";
import { generateToken, looksLikeToken } from "../token.ts";
import { authenticateToken, grantCovers, listTokens, mintToken, reportLeak, revokeToken, type TokenPorts } from "../tokens.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FROM = "10.1.2.3";

function setup() {
  const fakes = createFakePorts();
  const { d1, db } = migratedD1();
  const at = "2026-10-22T00:00:00.000Z";
  db.exec(`insert into users (id, created_at) values ('ann', '${at}'), ('bob', '${at}')`);
  db.exec(`insert into scopes (id, name, kind, created_at) values ('s1', 'acme', 'org', '${at}'), ('s2', 'other', 'org', '${at}')`);
  db.exec(`insert into scope_members (scope_id, user_id, role, created_at) values ('s1', 'ann', 'owner', '${at}')`);
  db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p1', 's1', 'secret', 'private', '${at}'), ('p2', 's1', 'other-secret', 'private', '${at}'), ('p3', 's2', 'x', 'private', '${at}')`);
  const ports: TokenPorts = { d1, clock: fakes.clock, rng: fakes.rng };
  return { fakes, ports, db };
}

async function mint(ports: TokenPorts, extra: Partial<Parameters<typeof mintToken>[1]> = {}) {
  const out = await mintToken(ports, { userId: "ann", scope: "acme", pack: "secret", ...extra });
  if (!out.ok) throw new Error(`mint refused: ${out.reason}`);
  return out;
}

describe("IT-PUB-012 minting", () => {
  it("makes a psr_ token that lasts 7 days by default and is stored only as a hash", async () => {
    const { ports, fakes } = setup();
    const { token, view } = await mint(ports);
    expect(token).toMatch(/^psr_[0-9a-f]{64}$/);
    expect(Date.parse(view.expires_at) - fakes.clock.now()).toBe(7 * DAY);
    const stored = JSON.stringify(await ports.d1.query("select * from read_tokens"));
    expect(stored).not.toContain(token.slice(4));
    expect(JSON.stringify(await listTokens(ports, "ann"))).not.toContain(token.slice(4));
  });

  it("allows 365 days and refuses 366, zero and fractions", async () => {
    const { ports } = setup();
    await mint(ports, { lifetimeDays: 365 });
    for (const lifetimeDays of [366, 0, -1, 1.5]) {
      expect(await mintToken(ports, { userId: "ann", scope: "acme", pack: "secret", lifetimeDays })).toEqual({ ok: false, reason: "lifetime" });
    }
  });

  it("refuses a person who does not manage the scope, and a pack that does not exist, as not found", async () => {
    const { ports } = setup();
    expect(await mintToken(ports, { userId: "bob", scope: "acme", pack: "secret" })).toEqual({ ok: false, reason: "not-found" });
    expect(await mintToken(ports, { userId: "ann", scope: "acme", pack: "missing" })).toEqual({ ok: false, reason: "not-found" });
    expect(await mintToken(ports, { userId: "ann", scope: "other", pack: "x" })).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses an unreadable CIDR", async () => {
    const { ports } = setup();
    for (const cidr of ["10.0.0.0/33", "nope", "10.0.0.0/8/1", "2001:db8::/129"]) {
      expect(await mintToken(ports, { userId: "ann", scope: "acme", cidr: [cidr] })).toEqual({ ok: false, reason: "cidr" });
    }
  });
});

describe("IT-PUB-013 authentication", () => {
  it("honours a token only inside its restriction, CIDR and lifetime", async () => {
    const { ports, fakes } = setup();
    const { token } = await mint(ports, { cidr: ["10.0.0.0/8"] });
    const grant = await authenticateToken(ports, token, FROM);
    expect(grant).toMatchObject({ scope: "acme", pack: "secret" });
    expect(grantCovers(grant!, { scope: "acme", pack: "secret" })).toBe(true);
    expect(grantCovers(grant!, { scope: "acme", pack: "other-secret" })).toBe(false);
    expect(await authenticateToken(ports, token, "192.0.2.1")).toBeNull();
    expect(await authenticateToken(ports, token, "not an address")).toBeNull();
    fakes.clock.advance(7 * DAY);
    expect(await authenticateToken(ports, token, FROM)).toBeNull();
  });

  it("covers every pack of the scope for a scope token, and no other scope", async () => {
    const { ports } = setup();
    const { token } = await mint(ports, { pack: undefined as never });
    const grant = (await authenticateToken(ports, token, FROM))!;
    expect(grantCovers(grant, { scope: "acme", pack: "other-secret" })).toBe(true);
    expect(grantCovers(grant, { scope: "other", pack: "x" })).toBe(false);
  });

  it("refuses once the minter no longer manages the scope", async () => {
    const { ports, db } = setup();
    const { token } = await mint(ports);
    expect(await authenticateToken(ports, token, FROM)).not.toBeNull();
    db.exec("update scope_members set role = 'member' where user_id = 'ann'");
    expect(await authenticateToken(ports, token, FROM)).toBeNull();
    db.exec("update scope_members set role = 'maintainer' where user_id = 'ann'");
    expect(await authenticateToken(ports, token, FROM)).not.toBeNull();
    db.exec("delete from scope_members where user_id = 'ann'");
    expect(await authenticateToken(ports, token, FROM)).toBeNull();
  });

  it("refuses a pack-restricted token whose pack row is gone", async () => {
    const { ports, db } = setup();
    const { token } = await mint(ports);
    db.exec("pragma foreign_keys = off");
    db.exec("delete from packs where id = 'p1'");
    expect(await authenticateToken(ports, token, FROM)).toBeNull();
  });

  it("refuses a label with any C0 or C1 control or DEL", async () => {
    const { ports } = setup();
    for (const label of ["a\u0000b", "a\u001fb", "a\u007fb", "a\u0085b", "a\u009fb"]) {
      expect(await mintToken(ports, { userId: "ann", scope: "acme", pack: "secret", label })).toEqual({ ok: false, reason: "label" });
    }
    expect((await mintToken(ports, { userId: "ann", scope: "acme", pack: "secret", label: "ci runner" })).ok).toBe(true);
  });

  it("refuses a revoked token and a value that is not a token", async () => {
    const { ports } = setup();
    const { token, view } = await mint(ports);
    expect(await revokeToken(ports, "bob", view.id)).toBe(false);
    expect(await revokeToken(ports, "ann", view.id)).toBe(true);
    expect(await authenticateToken(ports, token, FROM)).toBeNull();
    expect(await authenticateToken(ports, token.slice(0, 12), FROM)).toBeNull();
    expect(await authenticateToken(ports, generateToken(ports.rng), FROM)).toBeNull();
  });
});

describe("IT-AUDIT-006 last used", () => {
  it("moves at most hourly", async () => {
    const { ports, fakes } = setup();
    const { token, view } = await mint(ports);
    const t0 = new Date(fakes.clock.now()).toISOString();
    await authenticateToken(ports, token, FROM);
    fakes.clock.advance(10 * 60_000);
    await authenticateToken(ports, token, FROM);
    expect((await listTokens(ports, "ann")).find((t) => t.id === view.id)!.last_used_at).toBe(t0);
    fakes.clock.advance(60 * 60_000);
    await authenticateToken(ports, token, FROM);
    expect((await listTokens(ports, "ann")).find((t) => t.id === view.id)!.last_used_at).toBe(new Date(fakes.clock.now()).toISOString());
  });
});

describe("IT-PUB-032 leak reports", () => {
  it("revokes on the full token only", async () => {
    const { ports } = setup();
    const { token, view } = await mint(ports);
    await reportLeak(ports, token.slice(0, 12));
    await reportLeak(ports, `${token}0`);
    await reportLeak(ports, 42);
    expect(await authenticateToken(ports, token, FROM)).not.toBeNull();
    await reportLeak(ports, token);
    expect(await authenticateToken(ports, token, FROM)).toBeNull();
    expect((await listTokens(ports, "ann")).find((t) => t.id === view.id)).toMatchObject({ status: "revoked", revoked_reason: "leak-reported" });
    expect(looksLikeToken(token)).toBe(true);
  });
});

describe("CIDR", () => {
  it("matches IPv4 and IPv6 blocks and single hosts", () => {
    expect(inCidr("10.255.0.1", parseCidr("10.0.0.0/8")!)).toBe(true);
    expect(inCidr("11.0.0.1", parseCidr("10.0.0.0/8")!)).toBe(false);
    expect(inCidr("192.0.2.130", parseCidr("192.0.2.128/25")!)).toBe(true);
    expect(inCidr("192.0.2.127", parseCidr("192.0.2.128/25")!)).toBe(false);
    expect(inCidr("192.0.2.5", parseCidr("192.0.2.5")!)).toBe(true);
    expect(inCidr("2001:db8::1", parseCidr("2001:db8::/32")!)).toBe(true);
    expect(inCidr("2001:db9::1", parseCidr("2001:db8::/32")!)).toBe(false);
    expect(inCidr("2001:db8::1", parseCidr("10.0.0.0/8")!)).toBe(false);
    expect(inCidr("::ffff:10.1.2.3", parseCidr("10.0.0.0/8")!)).toBe(true);
    expect(inCidr("10.0.0.1", parseCidr("0.0.0.0/0")!)).toBe(true);
  });
});
