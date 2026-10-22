import { describe, expect, it } from "vitest";
import { IndexVersion, KeysDocument, PrivateEntry, RootIndex, ScopeIndex, VersionsDocument } from "./index-v1";
import * as f from "./fixtures";

const clone = <T>(v: T): T => structuredClone(v);

describe("root.json", () => {
  it("accepts a well-formed root", () => expect(RootIndex.safeParse(f.root).success).toBe(true));
  it("rejects a root whose expiry is not generated_at + 7 days", () => {
    expect(RootIndex.safeParse({ ...f.root, expires: "2026-10-30T10:00:00.000Z" }).success).toBe(false);
  });
  it("rejects a root with no kid or signature", () => {
    expect(RootIndex.safeParse({ ...f.root, kid: undefined }).success).toBe(false);
    expect(RootIndex.safeParse({ ...f.root, signature: undefined }).success).toBe(false);
  });
  it("rejects a malformed scope hash and a negative serial", () => {
    expect(RootIndex.safeParse({ ...f.root, scopes: [{ scope: "acme", sha256: "xyz", serial: 1 }] }).success).toBe(false);
    expect(RootIndex.safeParse({ ...f.root, serial: -1 }).success).toBe(false);
  });
  it("rejects a document of another kind", () => {
    expect(RootIndex.safeParse({ ...f.root, kind: "scope" }).success).toBe(false);
  });
});

describe("scope index", () => {
  it("accepts a well-formed scope index", () => expect(ScopeIndex.safeParse(f.scopeIndex).success).toBe(true));
  it("accepts a removed pack that stays listed", () => {
    const doc = clone(f.scopeIndex);
    Object.assign(doc.packs[0]!, { status: "removed" });
    expect(ScopeIndex.safeParse(doc).success).toBe(true);
  });
  it("rejects an unknown version status", () => {
    const doc = clone(f.scopeIndex);
    doc.packs[0]!.versions[0]!.status = "vanished";
    expect(ScopeIndex.safeParse(doc).success).toBe(false);
  });
  it("rejects a bad pack name", () => {
    const doc = clone(f.scopeIndex);
    doc.packs[0]!.name = "acme/gcp";
    expect(ScopeIndex.safeParse(doc).success).toBe(false);
  });
  it("rejects a private entry presented as a scope index", () => {
    expect(ScopeIndex.safeParse(f.privateEntry).success).toBe(false);
  });
});

describe("index version", () => {
  it("requires a reason for any status but active", () => {
    for (const status of ["deprecated", "yanked", "quarantined", "removed"]) {
      expect(IndexVersion.safeParse({ ...f.indexVersion, status }).success).toBe(false);
      expect(IndexVersion.safeParse({ ...f.indexVersion, status, reason: "why" }).success).toBe(true);
    }
  });
  it("requires security for revoked", () => {
    const revoked = { ...f.indexVersion, status: "revoked", reason: "why" };
    expect(IndexVersion.safeParse(revoked).success).toBe(false);
    expect(IndexVersion.safeParse({ ...revoked, security: "CVE-1" }).success).toBe(true);
  });
  it("rejects a tampered hash and a non-three-part version", () => {
    expect(IndexVersion.safeParse({ ...f.indexVersion, sha256: "A".repeat(64) }).success).toBe(false);
    expect(IndexVersion.safeParse({ ...f.indexVersion, version: "1.0" }).success).toBe(false);
  });
});

describe("private entry", () => {
  it("accepts a well-formed private entry", () => expect(PrivateEntry.safeParse(f.privateEntry).success).toBe(true));
  it("rejects a public scope index presented as a private entry", () => {
    expect(PrivateEntry.safeParse(f.scopeIndex).success).toBe(false);
  });
  it("rejects a version without its opaque id", () => {
    const doc = clone(f.privateEntry);
    delete (doc.versions[0] as Partial<(typeof doc.versions)[0]>).version_id;
    expect(PrivateEntry.safeParse(doc).success).toBe(false);
  });
  it("applies the status rules to its versions", () => {
    const doc = clone(f.privateEntry);
    doc.versions[0]!.status = "yanked";
    expect(PrivateEntry.safeParse(doc).success).toBe(false);
  });
  it("rejects a bad expiry", () => {
    expect(PrivateEntry.safeParse({ ...f.privateEntry, expires: f.privateEntry.generated_at }).success).toBe(false);
  });
});

describe("keys.json", () => {
  it("accepts a key set with a revoked kid", () => expect(KeysDocument.safeParse(f.keys).success).toBe(true));
  it("rejects a revoked key without revoked_at, and revoked_at on a live key", () => {
    const missing = clone(f.keys);
    delete (missing.keys[1] as { revoked_at?: string }).revoked_at;
    expect(KeysDocument.safeParse(missing).success).toBe(false);
    const stray = clone(f.keys);
    Object.assign(stray.keys[0]!, { revoked_at: f.keys.generated_at });
    expect(KeysDocument.safeParse(stray).success).toBe(false);
  });
  it("rejects an unknown key status", () => {
    const doc = clone(f.keys);
    doc.keys[0]!.status = "retired";
    expect(KeysDocument.safeParse(doc).success).toBe(false);
  });
});

describe("versions.json", () => {
  it("accepts and rejects", () => {
    expect(VersionsDocument.safeParse(f.versionsDoc).success).toBe(true);
    expect(VersionsDocument.safeParse({ ...f.versionsDoc, pack: "gcp" }).success).toBe(false);
  });
});
