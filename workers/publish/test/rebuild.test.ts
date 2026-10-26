import { migratedD1 } from "@packserver/core/identity/testing";
import { contentDigest } from "@packserver/core/validation";
import { describe, expect, it } from "vitest";
import { createIndexRebuilder, PRIVATE_RESIGN_MS, type IndexSigner } from "../src/coordinator";

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const PREINSTALL = '{"guards":[],"tasks":[],"forced_skills":[],"github_actions":[],"new":[]}';
interface ListedVersion {
  version: string;
  status: string;
  version_id?: string;
}
interface ScopeDoc {
  serial: number;
  packs: Array<{ name: string; latest_eligible: string | null; versions: ListedVersion[] }>;
}
interface Entry {
  pack: string;
  serial: number;
  versions: ListedVersion[];
}
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  const { d1, db } = migratedD1();
  const clock = { ms: NOW };
  const scopeCalls: Array<{ scope: string; unsigned: ScopeDoc }> = [];
  const privateCalls: Array<{ scope: string; entries: Entry[] }> = [];
  const signer: IndexSigner = {
    async signScopeIndex(request) {
      scopeCalls.push(request as unknown as (typeof scopeCalls)[number]);
            const serial = Number(request.unsigned.serial);
      await d1.query(`insert into signed_documents (doc_key, serial, sha256, content_hash, signed_at) values (?, ?, ?, 'c', ?) on conflict (doc_key) do update set serial = excluded.serial`, [`scope:${request.scope}`, serial, "a".repeat(64), iso(clock.ms)]);
      return { sha256: "a".repeat(64), serial };
    },
    async signPrivateEntries(request) {
      privateCalls.push(request as unknown as (typeof privateCalls)[number]);
      for (const entry of request.entries) {
        await d1.query(
          `insert into signed_documents (doc_key, serial, sha256, content_hash, signed_at) values (?, ?, ?, ?, ?)
           on conflict (doc_key) do update set serial = excluded.serial, content_hash = excluded.content_hash, signed_at = excluded.signed_at`,
          [`private:${entry.pack}`, entry.serial, "b".repeat(64), await contentDigest(entry as never), iso(clock.ms)],
        );
      }
      return {};
    },
  };
  const rebuilder = createIndexRebuilder({ d1, signer, now: () => clock.ms });
  db.exec(`insert into scopes (id, name, kind, state, created_at) values ('s', 'acme', 'org', 'active', 'x');
    insert into packs (id, scope_id, name, visibility, created_at) values ('p1', 's', 'gcp', 'public', 'x'), ('p2', 's', 'secret', 'private', 'x');`);
  const version = (id: string, pack: string, v: string, o: { state?: string; published?: string | null; reason?: string; security?: string; changed?: string } = {}) =>
    db
      .prepare(
        `insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified, min_engine_version, requires, preinstall, status_reason, status_security, status_changed_at)
         values (?, ?, ?, ?, ?, 10, ?, 0, 0, '1.0.0', '[]', ?, ?, ?, ?)`,
      )
      .run(id, pack, v, o.state ?? "active", "d".repeat(64), o.published === undefined ? iso(NOW - 30 * DAY) : o.published, PREINSTALL, o.reason ?? null, o.security ?? null, o.changed ?? null);
  return { d1, db, clock, rebuilder, scopeCalls, privateCalls, version };
}

describe("rebuilding a scope's index", () => {
  it("lists the published versions of public packs, never an approved one, and starts the serial at 1", async () => {
    const { rebuilder, scopeCalls, version } = setup();
    version("v1", "p1", "1.0.0");
    version("v2", "p1", "1.1.0", { state: "approved", published: null });
    version("v3", "p1", "1.2.0", { state: "yanked", reason: "broken", changed: iso(NOW - DAY) });
    expect(await rebuilder.rebuild("acme")).toEqual({ sha256: "a".repeat(64), serial: 1 });

    const doc = scopeCalls[0]!.unsigned;
    expect(doc.serial).toBe(1);
    expect(doc.packs.map((p) => p.name)).toEqual(["@acme/gcp"]);
    expect(doc.packs[0]!.versions.map((v) => [v.version, v.status])).toEqual([["1.2.0", "yanked"], ["1.0.0", "active"]]);
    expect(doc.packs[0]!.versions[0]).toMatchObject({ reason: "broken", min_engine_version: "1.0.0", requires: [], source_commit: null });
    expect(doc.packs[0]!.latest_eligible).toBe("1.0.0");
  });

  it("takes the next serial from what the validator last signed", async () => {
    const { rebuilder, scopeCalls, version } = setup();
    version("v1", "p1", "1.0.0");
    await rebuilder.rebuild("acme");
    await rebuilder.rebuild("acme");
    expect(scopeCalls.map((c) => c.unsigned.serial)).toEqual([1, 2]);
  });

  it("states a reason for any status but active and a security note for a revocation, defaulting both to the status", async () => {
    const { rebuilder, scopeCalls, version } = setup();
    version("v1", "p1", "1.0.0", { state: "deprecated", changed: iso(NOW - DAY) });
    version("v2", "p1", "1.1.0", { state: "revoked", reason: "stolen key", changed: iso(NOW - 400 * DAY) });
    await rebuilder.rebuild("acme");
    const versions = scopeCalls[0]!.unsigned.packs[0]!.versions;
    expect(versions.find((v) => v.version === "1.0.0")).toMatchObject({ status: "deprecated", reason: "deprecated" });
    expect(versions.find((v) => v.version === "1.1.0")).toMatchObject({ status: "revoked", reason: "stolen key", security: "stolen key" });
  });

  it("carries the scope's current verification facts onto its versions, public and private alike", async () => {
    const { rebuilder, scopeCalls, db, version } = setup();
    version("v1", "p1", "1.0.0");
    version("v2", "p2", "1.0.0");
    db.exec(`update scopes set verified_domain = 'acme.example' where id = 's'`);
    await rebuilder.rebuild("acme");
    expect(scopeCalls[0]!.unsigned.packs[0]!.versions[0]).toMatchObject({ verified: false, verified_domain: "acme.example", verified_github_org: null });
    expect(db.prepare(`select verified_domain from pack_versions where id = 'v2'`).get()).toEqual({ verified_domain: "acme.example" });
  });

  it("signs an empty index for a scope with nothing public", async () => {
    const { rebuilder, scopeCalls } = setup();
    await rebuilder.rebuild("acme");
    expect(scopeCalls[0]!.unsigned.packs).toEqual([]);
  });

  it("refuses a scope that does not exist", async () => {
    await expect(setup().rebuilder.rebuild("nope")).rejects.toThrow(/rebuild.unknown_scope/);
  });
});

describe("rebuilding private entries", () => {
  it("never puts a private pack in the public index and signs its entry keyed by version id", async () => {
    const { rebuilder, scopeCalls, privateCalls, version } = setup();
    version("v1", "p1", "1.0.0");
    version("v2", "p2", "1.0.0");
    await rebuilder.rebuild("acme");
    expect(scopeCalls[0]!.unsigned.packs.map((p) => p.name)).toEqual(["@acme/gcp"]);
    expect(privateCalls).toHaveLength(1);
    expect(privateCalls[0]!.entries.map((e) => [e.pack, e.versions.map((v) => v.version_id)])).toEqual([["@acme/secret", ["v2"]]]);
  });

  it("signs a private entry again only when its content changed or its signature is a day old", async () => {
    const { rebuilder, privateCalls, clock, version, db } = setup();
    version("v2", "p2", "1.0.0");
    await rebuilder.rebuild("acme");
    expect(privateCalls).toHaveLength(1);

    clock.ms += 60_000;
    await rebuilder.rebuild("acme");
    expect(privateCalls).toHaveLength(1);

    version("v3", "p2", "1.1.0");
    await rebuilder.rebuild("acme");
    expect(privateCalls).toHaveLength(2);
    expect(privateCalls[1]!.entries[0]!.serial).toBe(2);

    clock.ms += PRIVATE_RESIGN_MS;
    await rebuilder.rebuild("acme");
    expect(privateCalls).toHaveLength(3);

    db.exec(`update pack_versions set state = 'yanked', status_reason = 'bad', status_changed_at = 'x' where id = 'v3'`);
    clock.ms += 1000;
    await rebuilder.rebuild("acme");
    expect(privateCalls).toHaveLength(4);
  });
});
