import { describe, expect, it } from "vitest";
import {
  CACHE_IMMUTABLE,
  CACHE_PRIVATE,
  CACHE_PUBLIC_VIEW,
  answerHash,
  buildListing,
  lookupVersion,
  objectKey,
  objectResponseHeaders,
  packIsRemoved,
  parseVersionRow,
  publicObjectHttpMetadata,
  summarise,
  viewCacheControl,
  type VersionRow,
} from "../view";

const row = (version: string, state = "active", over: Partial<VersionRow> = {}): VersionRow => ({
  version,
  state,
  sha256: `${version.replace(/\D/g, "")}`.padEnd(64, "a"),
  upload_sha256: null,
  size_bytes: 10,
  published_at: "2026-10-01T00:00:00.000Z",
  verified: false,
  verified_domain: null,
  verified_github_org: null,
  source_verified: false,
  min_engine_version: "1.0.0",
  requires: [],
  source_commit: null,
  score: null,
  report_key: null,
  ...over,
});

describe("object keys and headers", () => {
  it("names the four write-once objects and the history", () => {
    expect(objectKey("@a/b", "archive", "1.0.0")).toBe("@a/b/1.0.0/pack.tar.zst");
    expect(objectKey("@a/b", "sha256", "1.0.0")).toBe("@a/b/1.0.0/pack.tar.zst.sha256");
    expect(objectKey("@a/b", "attestation", "1.0.0")).toBe("@a/b/1.0.0/.attestation.json");
    expect(objectKey("@a/b", "meta", "1.0.0")).toBe("@a/b/1.0.0/meta.json");
    expect(objectKey("@a/b", "versions")).toBe("@a/b/versions.json");
    expect(() => objectKey("@a/b", "meta")).toThrow();
  });

  it.each(["archive", "sha256", "attestation", "meta", "versions"] as const)("serves %s as a non-HTML attachment", (kind) => {
    const meta = publicObjectHttpMetadata(kind);
    expect(meta.contentDisposition).toMatch(/^attachment; filename="[^"]+"$/);
    expect(meta.contentType).not.toMatch(/html|svg|xml/);
  });

  it("is immutable on the write-once versioned objects and on nothing that is rewritten", () => {
    for (const kind of ["archive", "sha256", "attestation", "meta"] as const) expect(publicObjectHttpMetadata(kind).cacheControl).toBe(CACHE_IMMUTABLE);
    expect(publicObjectHttpMetadata("versions").cacheControl).not.toMatch(/immutable/);
  });

  it("adds nosniff to a streamed object and never lets a private one be stored", () => {
    expect(objectResponseHeaders("archive", { private: false })).toMatchObject({ "x-content-type-options": "nosniff", "cache-control": CACHE_IMMUTABLE });
    expect(objectResponseHeaders("archive", { private: true })).toMatchObject({ "x-content-type-options": "nosniff", "cache-control": CACHE_PRIVATE });
  });

  it("marks a view private for any cookie or token and shareable otherwise, never immutable", () => {
    expect(viewCacheControl({ cookie: null, authorization: null })).toBe(CACHE_PUBLIC_VIEW);
    expect(viewCacheControl({ cookie: "sid=1", authorization: null })).toBe(CACHE_PRIVATE);
    expect(viewCacheControl({ cookie: null, authorization: "Bearer x" })).toBe(CACHE_PRIVATE);
    expect(CACHE_PUBLIC_VIEW).not.toMatch(/immutable/);
  });

});

describe("listing and lookup", () => {
  const rows = [row("1.0.0"), row("1.1.0", "yanked"), row("1.2.0", "quarantined"), row("1.3.0", "removed"), row("1.4.0", "pending"), row("0.9.0", "deprecated")];
  const notes = new Map([
    ["1.1.0", { reason: "broken" }],
    ["1.2.0", { reason: "under review" }],
    ["0.9.0", { reason: "old" }],
  ]);

  it("lists only published versions, newest first, and never points latest at a held one", () => {
    const listing = buildListing("@a/b", rows, notes);
    expect(listing.versions.map((v) => [v.version, v.status])).toEqual([
      ["1.3.0", "removed"],
      ["1.2.0", "quarantined"],
      ["1.1.0", "yanked"],
      ["1.0.0", "active"],
      ["0.9.0", "deprecated"],
    ]);
    expect(listing.latest_eligible).toBe("1.0.0");
    expect(listing.status).toBe("active");
  });

  it("carries the reason on a non-active version and drops the hash of a removed one", () => {
    const [removed, quarantined, yanked] = buildListing("@a/b", rows, notes).versions;
    expect(removed).not.toHaveProperty("sha256");
    expect(quarantined).toMatchObject({ reason: "under review", under_review: true });
    expect(yanked).toMatchObject({ reason: "broken", yanked: true });
  });

  it("calls a pack removed only when every published version is", () => {
    expect(packIsRemoved([row("1.0.0", "removed"), row("1.1.0", "removed")])).toBe(true);
    expect(packIsRemoved([row("1.0.0", "removed"), row("1.1.0")])).toBe(false);
    expect(packIsRemoved([row("1.0.0", "pending")])).toBe(false);
    expect(buildListing("@a/b", [row("1.0.0", "removed")], new Map())).toMatchObject({ status: "removed", latest_eligible: null });
  });

  it("answers each status on an exact read", () => {
    expect(lookupVersion(rows, "1.1.0")).toMatchObject({ kind: "found", status: "yanked" });
    expect(lookupVersion(rows, "1.2.0").kind).toBe("held");
    expect(lookupVersion(rows, "1.3.0").kind).toBe("removed");
    expect(lookupVersion(rows, "1.4.0").kind).toBe("missing");
    expect(lookupVersion(rows, "9.9.9").kind).toBe("missing");
  });

  it("summarises a revoked version with its security note only", () => {
    expect(summarise(row("1.0.0", "revoked"), { reason: "r", security: "s" })).toMatchObject({ reason: "r", security: "s" });
    expect(summarise(row("1.0.0", "active"), { reason: "r", security: "s" })).not.toHaveProperty("reason");
  });
});

describe("row parsing", () => {
  it("reads D1's integers as booleans and the requirement list from JSON", () => {
    const parsed = parseVersionRow({ version: "1.0.0", state: "active", sha256: "a", size_bytes: 3, verified: 1, source_verified: 0, requires: '["x"]', score: 0 });
    expect(parsed).toMatchObject({ verified: true, source_verified: false, requires: ["x"], score: 0, upload_sha256: null });
  });
});

describe("answerHash", () => {
  const candidate = (state: string, sha256: string, upload: string | null = null) => ({ pack: "@a/b", version: "1.0.0", state, sha256, upload_sha256: upload });
  it("answers canonical before upload and carries the status", () => {
    expect(answerHash("c", [candidate("yanked", "c", "u")])).toEqual({ result: "canonical", pack: "@a/b", version: "1.0.0", status: "yanked" });
    expect(answerHash("u", [candidate("active", "c", "u")])).toMatchObject({ result: "upload" });
  });
  it("treats unpublished, removed and unmatched hashes alike", () => {
    expect(answerHash("c", [candidate("pending", "c")])).toEqual({ result: "unknown" });
    expect(answerHash("c", [candidate("removed", "c")])).toEqual({ result: "unknown" });
    expect(answerHash("z", [candidate("active", "c")])).toEqual({ result: "unknown" });
    expect(answerHash("z", [])).toEqual({ result: "unknown" });
  });
});
