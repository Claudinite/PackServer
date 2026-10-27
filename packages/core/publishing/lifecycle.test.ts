import { describe, expect, it } from "vitest";
import { HARD_DELETE_WINDOW_MS, SOFT_DELETE_WINDOW_MS, deletable, publicKeysOf, softDeleteExpired } from "./lifecycle";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const row = (over: Partial<Parameters<typeof deletable>[0]> = {}) => ({
  id: "v1",
  version: "1.0.0",
  state: "active",
  publishedAt: new Date(NOW - 3_600_000).toISOString(),
  ...over,
});

describe("IT-PUB-024 the hard-delete rule", () => {
  it("allows an unfetched version inside 72 hours", () => {
    expect(deletable(row(), NOW, 0)).toEqual({ ok: true });
  });

  it("refuses a fetched version, an old one, and one a person may not erase", () => {
    expect(deletable(row(), NOW, 1)).toEqual({ ok: false, reason: "fetched" });
    expect(deletable(row({ publishedAt: new Date(NOW - HARD_DELETE_WINDOW_MS).toISOString() }), NOW, 0)).toEqual({ ok: false, reason: "window" });
    expect(deletable(row({ state: "revoked" }), NOW, 0)).toEqual({ ok: false, reason: "state" });
    expect(deletable(row({ state: "quarantined" }), NOW, 0)).toEqual({ ok: false, reason: "state" });
    expect(deletable(row({ publishedAt: null }), NOW, 0)).toEqual({ ok: false, reason: "not_published" });
  });

  it("lets a deprecated or yanked version go too", () => {
    expect(deletable(row({ state: "yanked" }), NOW, 0)).toEqual({ ok: true });
    expect(deletable(row({ state: "deprecated" }), NOW, 0)).toEqual({ ok: true });
  });
});

describe("IT-PUB-025 the soft-delete window", () => {
  it("expires at seven days", () => {
    const at = new Date(NOW - SOFT_DELETE_WINDOW_MS + 1).toISOString();
    expect(softDeleteExpired(at, NOW)).toBe(false);
    expect(softDeleteExpired(new Date(NOW - SOFT_DELETE_WINDOW_MS).toISOString(), NOW)).toBe(true);
  });
});

describe("the objects a removed version leaves behind", () => {
  it("names the four write-once objects and the contents document", () => {
    expect(publicKeysOf("@acme/gcp", "1.0.0")).toHaveLength(5);
    expect(new Set(publicKeysOf("@acme/gcp", "1.0.0")).size).toBe(5);
  });
});
