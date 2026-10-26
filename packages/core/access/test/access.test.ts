import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { migratedD1 } from "../../identity/testing.ts";
import { FETCH_LOG_RETENTION_DAYS, addGrant, isAccountId, listFetches, listGrants, mayRead, readablePacks, recordFetches, removeGrant, type Caller } from "../index.ts";

const DAY = 86_400_000;

function setup() {
  const fakes = createFakePorts();
  const { d1, db } = migratedD1();
  const at = "2026-10-22T00:00:00.000Z";
  db.exec(`insert into users (id, created_at) values ('ann', '${at}'), ('bob', '${at}')`);
  db.exec(`insert into identities (id, user_id, provider, provider_user_id, login, created_at) values ('i1', 'ann', 'github', '1001', 'alice', '${at}')`);
  db.exec(`insert into scopes (id, name, kind, created_at) values ('s1', 'acme', 'org', '${at}')`);
  db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p1', 's1', 'secret', 'private', '${at}'), ('p2', 's1', 'other', 'private', '${at}'), ('p3', 's1', 'open', 'public', '${at}')`);
  return { fakes, d1, ports: { d1, clock: fakes.clock, rng: fakes.rng } };
}

const oidc = (ownerId: string, visibility?: string): Caller => ({ kind: "oidc", ownerId, repository: "r", visibility });
const names = async (d1: ReturnType<typeof setup>["d1"], caller: Caller) => (await readablePacks(d1, caller)).map((p) => p.name);

describe("IT-PRIV-016 the account id is matched", () => {
  it("lets an allowlisted account's repositories read and no one else's", async () => {
    const { d1, ports } = setup();
    await addGrant(ports, { packId: "p1", accountId: "1001", accountType: "user", by: "ann" });
    expect(await names(d1, oidc("1001", "public"))).toEqual(["secret"]);
    expect(await names(d1, oidc("2002", "private"))).toEqual([]);
  });

  it("holds an organisation entry to private repositories unless cleared", async () => {
    const { d1, ports } = setup();
    await addGrant(ports, { packId: "p1", accountId: "3003", accountType: "organization", by: "ann" });
    expect(await names(d1, oidc("3003", "private"))).toEqual(["secret"]);
    expect(await names(d1, oidc("3003", "public"))).toEqual([]);
    expect(await names(d1, oidc("3003"))).toEqual([]);
    await addGrant(ports, { packId: "p1", accountId: "3003", accountType: "organization", privateReposOnly: false, by: "ann" });
    expect(await names(d1, oidc("3003", "public"))).toEqual(["secret"]);
  });

  it("never lists a public pack, whatever it is granted", async () => {
    const { d1, ports } = setup();
    await addGrant(ports, { packId: "p3", accountId: "1001", accountType: "user", by: "ann" });
    expect(await names(d1, oidc("1001", "private"))).toEqual([]);
  });

  it("accepts numeric ids only", () => {
    expect(["1001", "9007199254740993"].every(isAccountId)).toBe(true);
    expect(["alice", "", "0", "10 01", 1001].some(isAccountId)).toBe(false);
  });
});

describe("IT-PRIV-017 and IT-PRIV-005 a signed-in person, and revoking", () => {
  it("reads while their GitHub account is on the allowlist and not after it is removed", async () => {
    const { d1, ports } = setup();
    const person: Caller = { kind: "session", userId: "ann" };
    await addGrant(ports, { packId: "p1", accountId: "1001", accountType: "user", by: "ann" });
    expect(await mayRead(d1, person, "p1")).toBe(true);
    expect(await mayRead(d1, { kind: "device", userId: "ann" }, "p2")).toBe(false);
    expect(await mayRead(d1, { kind: "session", userId: "bob" }, "p1")).toBe(false);
    expect(await removeGrant(ports, "p1", "1001")).toBe(true);
    expect(await removeGrant(ports, "p1", "1001")).toBe(false);
    expect(await mayRead(d1, person, "p1")).toBe(false);
    expect(await listGrants(d1, "p1")).toEqual([]);
  });
});

describe("IT-PRIV-018 a psr_ grant", () => {
  it("covers the one pack it names, or every private pack of its scope", async () => {
    const { d1 } = setup();
    expect(await names(d1, { kind: "token", grant: { id: "t", user_id: "ann", scope: "acme", pack: "secret" } })).toEqual(["secret"]);
    expect(await names(d1, { kind: "token", grant: { id: "t", user_id: "ann", scope: "acme", pack: null } })).toEqual(["other", "secret"]);
    expect(await names(d1, { kind: "token", grant: { id: "t", user_id: "ann", scope: "elsewhere", pack: null } })).toEqual([]);
  });
});

describe("IT-TELEM-008 the fetch log", () => {
  it("keeps reads by account and repository for 90 days", async () => {
    const { d1, ports, fakes } = setup();
    await recordFetches(ports, [{ packId: "p1", kind: "index", outcome: "served", caller: oidc("1001", "private"), callerHash: "h" }]);
    fakes.clock.advance((FETCH_LOG_RETENTION_DAYS - 1) * DAY);
    await recordFetches(ports, [{ packId: "p1", kind: "download", versionId: "v1", outcome: "served", caller: { kind: "session", userId: "ann" }, callerHash: undefined, accountId: "1001" }]);
    expect((await listFetches(d1, "p1")).map((f) => f.kind)).toEqual(["download", "index"]);
    fakes.clock.advance(2 * DAY);
    await recordFetches(ports, [{ packId: "p1", kind: "index", outcome: "denied", caller: oidc("2002", "private"), callerHash: "h2" }]);
    const left = await listFetches(d1, "p1");
    expect(left.map((f) => f.kind)).toEqual(["index", "download"]);
    expect(left.at(-1)).toMatchObject({ account_id: "1001", repository: null });
    expect(left[0]).toMatchObject({ outcome: "denied", account_id: "2002", repository: "r" });
  });
});
