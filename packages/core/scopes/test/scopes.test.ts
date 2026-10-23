import { describe, expect, it } from "vitest";
import { migratedD1 } from "../../identity/testing.ts";
import {
  TRANSFER_WINDOW_MS, acceptTransfer, authorize, createOrg, deleteOrg, expireOffers, invite, loadProfile, loadScope, movedTo, offerTransfer, personalScopeStatements,
  publisherMark, removePerson, renameScope, satisfies, setRole, type ScopePorts,
} from "../index.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");

function world() {
  const { d1, db } = migratedD1();
  let now = NOW;
  let n = 0;
  const ports: ScopePorts = {
    d1,
    clock: { now: () => now },
    rng: { float: () => 0.5, uuid: () => crypto.randomUUID(), bytes: (len) => Uint8Array.from({ length: len }, (_, i) => (++n + i) & 255) },
  };
  const iso = new Date(NOW).toISOString();
  const person = async (id: string, handle: string, email?: string) => {
    db.exec(`insert into users (id, handle, created_at) values ('${id}', '${handle}', '${iso}')`);
    await d1.batch(personalScopeStatements(ports, id, handle));
    if (email) db.exec(`insert into user_emails (user_id, address, source, created_at) values ('${id}', '${email}', 'github', '${iso}')`);
  };
  const pack = (scope: string, name: string, visibility = "public") => {
    db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('pk-${scope}-${name}', (select id from scopes where name = '${scope}'), '${name}', '${visibility}', '${iso}')`);
    return `pk-${scope}-${name}`;
  };
  return { ports, d1, db, person, pack, advance: (ms: number) => (now += ms) };
}

describe("publisherMark (REQ-SCOPE-015)", () => {
  it("encodes the proof itself and keeps the label to the hover", () => {
    expect(publisherMark({ verified_domain: "acme.com", verified_github_org: "acme", verified_publisher: true })).toMatchObject({ text: "● acme.com", hover_label: "Verified Publisher" });
    expect(publisherMark({ verified_domain: null, verified_github_org: "acme" })).toMatchObject({ kind: "github", text: "● github.com/acme", hover_label: null });
    expect(publisherMark({ verified_domain: null, verified_github_org: null, verified_publisher: true })).toMatchObject({ kind: "unproven", text: "○ Unproven", hover_label: null });
  });
});

describe("roles", () => {
  it("holds an owner to every need and a maintainer to the lower one", () => {
    expect([satisfies("owner", "owner"), satisfies("maintainer", "owner"), satisfies("maintainer", "maintainer"), satisfies(null, "maintainer")]).toEqual([true, false, true, false]);
  });
});

describe("personal scopes (REQ-SCOPE-001)", () => {
  it("gives a handle its scope, owned by that person alone", async () => {
    const w = world();
    await w.person("u1", "ann");
    expect(await loadScope(w.d1, "ann")).toMatchObject({ kind: "user", name: "ann" });
    const scope = (await loadScope(w.d1, "ann"))!;
    expect(await invite(w.ports, scope, "u1", { handle: "ann" }, "owner")).toMatchObject({ ok: false, reason: "personal_scope" });
    expect(await deleteOrg(w.ports, scope)).toMatchObject({ ok: false, reason: "personal_scope" });
  });

  it("makes no scope for a handle the account does not hold", async () => {
    const w = world();
    w.db.exec(`insert into users (id, handle, created_at) values ('u1', null, '${new Date(NOW).toISOString()}')`);
    await w.d1.batch(personalScopeStatements(w.ports, "u1", "ghost"));
    expect(await loadScope(w.d1, "ghost")).toBeNull();
  });
});

describe("organisations and their people (REQ-SCOPE-002, REQ-SCOPE-003)", () => {
  it("makes the creator the only owner and refuses a taken or unhandled name", async () => {
    const w = world();
    await w.person("u1", "ann");
    w.db.exec(`insert into users (id, handle, created_at) values ('u2', null, '${new Date(NOW).toISOString()}')`);
    const made = await createOrg(w.ports, "u1", "Acme");
    expect(made).toMatchObject({ ok: true, scope: { name: "acme", kind: "org" } });
    expect((await w.d1.query("select user_id, role from scope_members where scope_id = ?", [(made as { scope: { id: string } }).scope.id])).rows).toEqual([{ user_id: "u1", role: "owner" }]);
    expect(await createOrg(w.ports, "u1", "acme")).toMatchObject({ ok: false, reason: "taken" });
    expect(await createOrg(w.ports, "u1", "ann")).toMatchObject({ ok: false, reason: "taken" });
    expect(await createOrg(w.ports, "u2", "other")).toMatchObject({ ok: false, reason: "no_handle" });
    expect(await createOrg(w.ports, "u1", "admin")).toMatchObject({ ok: false, reason: "reserved" });
  });

  it("never leaves an organisation without an owner", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    const org = ((await createOrg(w.ports, "u1", "acme")) as { scope: Parameters<typeof invite>[1] }).scope;
    expect(await setRole(w.ports, org, "ann", "maintainer")).toMatchObject({ ok: false, reason: "last_owner" });
    expect(await removePerson(w.ports, org, "ann")).toMatchObject({ ok: false, reason: "last_owner" });
    expect(await invite(w.ports, org, "u1", { handle: "bob" }, "owner")).toEqual({ ok: true, outcome: "added" });
    expect(await invite(w.ports, org, "u1", { handle: "bob" }, "owner")).toMatchObject({ ok: false, reason: "already_a_person" });
    expect(await setRole(w.ports, org, "ann", "maintainer")).toEqual({ ok: true, outcome: "changed" });
    expect(await removePerson(w.ports, org, "bob")).toMatchObject({ ok: false, reason: "last_owner" });
  });
});

describe("cross-scope standing (REQ-SCOPE-016)", () => {
  it("answers not found for a private resource and forbidden for a public one", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    await createOrg(w.ports, "u1", "acme");
    const ask = (userId: string | undefined, resource: "public" | "private", need: "owner" | "maintainer" = "maintainer") => authorize(w.d1, { scope: "acme", userId, need, resource });
    expect(await ask("u1", "private")).toMatchObject({ kind: "allow", role: "owner" });
    expect(await ask("u2", "public")).toEqual({ kind: "forbidden" });
    expect(await ask("u2", "private")).toEqual({ kind: "not_found" });
    expect(await ask(undefined, "public")).toEqual({ kind: "forbidden" });
    expect(await authorize(w.d1, { scope: "nope", userId: "u1", need: "owner", resource: "public" })).toEqual({ kind: "not_found" });
  });
});

describe("never recycled (REQ-SCOPE-012, REQ-SCOPE-013)", () => {
  it("refuses to delete an organisation that owns a pack, then retires its name once it is gone", async () => {
    const w = world();
    await w.person("u1", "ann");
    const org = ((await createOrg(w.ports, "u1", "acme")) as { scope: Parameters<typeof deleteOrg>[1] }).scope;
    w.pack("acme", "gcp");
    expect(await deleteOrg(w.ports, org)).toMatchObject({ ok: false, reason: "owns_packs", packs: ["@acme/gcp"] });
    w.db.exec("delete from packs");
    expect(await deleteOrg(w.ports, org)).toEqual({ ok: true });
    expect(await loadScope(w.d1, "acme")).toBeNull();
    expect(await createOrg(w.ports, "u1", "acme")).toMatchObject({ ok: false, reason: "taken" });
    expect((await w.d1.query("select kind, name from retired_names")).rows).toEqual([{ kind: "scope", name: "acme" }]);
  });

  it("retires the old name when a scope is renamed", async () => {
    const w = world();
    await w.person("u1", "ann");
    const org = ((await createOrg(w.ports, "u1", "acme")) as { scope: Parameters<typeof renameScope>[1] }).scope;
    expect(await renameScope(w.ports, org, "acme-inc")).toEqual({ ok: true, name: "acme-inc" });
    expect((await w.d1.query("select name from retired_names where kind = 'scope'")).rows).toEqual([{ name: "acme" }]);
    expect(await createOrg(w.ports, "u1", "acme")).toMatchObject({ ok: false, reason: "taken" });
  });
});

describe("transfers (REQ-SCOPE-014)", () => {
  async function setup() {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    await createOrg(w.ports, "u1", "src");
    await createOrg(w.ports, "u2", "dst");
    const packId = w.pack("src", "gcp");
    const offer = () => offerTransfer(w.ports, { packId, packName: "gcp", fromScope: "src", toScope: "dst", offeredBy: "u1" });
    return { w, packId, offer };
  }

  it("moves the pack only when the receiving owner accepts, and then answers the old id as moved", async () => {
    const { w, packId, offer } = await setup();
    const made = await offer();
    const id = (made as { transfer: { id: string } }).transfer.id;
    expect(await offer()).toMatchObject({ ok: false, reason: "already_offered" });
    expect(await acceptTransfer(w.ports, "u1", id)).toMatchObject({ ok: false, reason: "forbidden" });
    expect((await w.d1.query("select s.name from packs p join scopes s on s.id = p.scope_id where p.id = ?", [packId])).rows).toEqual([{ name: "src" }]);
    expect(await acceptTransfer(w.ports, "u2", id)).toMatchObject({ ok: true });
    expect((await w.d1.query("select s.name from packs p join scopes s on s.id = p.scope_id where p.id = ?", [packId])).rows).toEqual([{ name: "dst" }]);
    expect(await movedTo(w.d1, "src", "gcp")).toBe("@dst/gcp");
    expect(await movedTo(w.d1, "dst", "gcp")).toBeNull();
    expect(await acceptTransfer(w.ports, "u2", id)).toMatchObject({ ok: false, reason: "settled" });
  });

  it("lapses an offer after seven days", async () => {
    const { w, packId, offer } = await setup();
    const id = ((await offer()) as { transfer: { id: string } }).transfer.id;
    w.advance(TRANSFER_WINDOW_MS - 1);
    await expireOffers(w.d1, w.ports.clock.now());
    expect((await w.d1.query("select state from pack_transfers where id = ?", [id])).rows).toEqual([{ state: "offered" }]);
    w.advance(1);
    expect(await acceptTransfer(w.ports, "u2", id)).toMatchObject({ ok: false, reason: "lapsed" });
    expect((await w.d1.query("select scope_id from packs where id = ?", [packId])).rows).toHaveLength(1);
    expect(await movedTo(w.d1, "src", "gcp")).toBeNull();
    expect(await offer()).toMatchObject({ ok: true });
  });

  it("refuses an offer that would collide with a pack of the same name", async () => {
    const { w, offer } = await setup();
    w.pack("dst", "gcp");
    expect(await offer()).toMatchObject({ ok: false, reason: "name_taken" });
  });
});

describe("profiles (REQ-SCOPE-015)", () => {
  it("lists public packs that have a promoted version, and the label only for an approved application", async () => {
    const w = world();
    await w.person("u1", "ann");
    const org = ((await createOrg(w.ports, "u1", "acme")) as { scope: { id: string } }).scope;
    const live = w.pack("acme", "live");
    w.pack("acme", "bare");
    w.pack("acme", "secret", "private");
    const iso = new Date(NOW).toISOString();
    w.db.exec(`insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values ('v1', '${live}', '1.0.0', 'active', 'x', 1, '${iso}', 0, 0)`);
    w.db.exec(`insert into vp_applications (id, scope_id, state, applied_by, applied_at) values ('a1', '${org.id}', 'pending', 'u1', '${iso}')`);
    expect(await loadProfile(w.d1, "acme")).toMatchObject({ packs: ["@acme/live"], verified_publisher: false });
    w.db.exec("update vp_applications set state = 'approved'");
    expect(await loadProfile(w.d1, "acme")).toMatchObject({ verified_publisher: true, mark: { hover_label: null, kind: "unproven" } });
    expect(await loadProfile(w.d1, "nobody")).toBeNull();
  });
});
