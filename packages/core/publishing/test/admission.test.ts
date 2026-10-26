import { sha256Hex } from "../../index/bytes";
import { describe, expect, it } from "vitest";
import {
  capMessage, checkIntegrity, dryRunCap, dryRunStagingKey, hasZstdMagic, isVerifiedPublisher, isYoungAccount, newPackCap, nextRunStart,
  nextUtcMidnight, utcDay, MAX_UPLOAD_BYTES, SOFT_RATE_LIMIT_INTERVAL_MS, stagingPrefix,
} from "../index";

const DAY = 86_400_000;
const zstd = (size: number): Uint8Array => {
  const out = new Uint8Array(size);
  out.set([0x28, 0xb5, 0x2f, 0xfd]);
  return out;
};
const stored = (bytes: Uint8Array | null, size = bytes?.byteLength ?? 0) => ({ size, read: async () => bytes });

describe("UTC days", () => {
  it("names the day an instant falls in and the instant the next one starts", () => {
    const late = Date.UTC(2026, 9, 22, 23, 59, 59, 999);
    expect(utcDay(late)).toBe("2026-10-22");
    expect(nextUtcMidnight(late)).toBe(late + 1);
    expect(utcDay(nextUtcMidnight(late))).toBe("2026-10-23");
    expect(nextUtcMidnight(Date.UTC(2026, 9, 22))).toBe(Date.UTC(2026, 9, 23));
  });
});

describe("caps", () => {
  it("gives a Verified Publisher 20 new packs and anyone else 5", () => {
    expect([newPackCap(false), newPackCap(true)]).toEqual([5, 20]);
    expect(isVerifiedPublisher({ verified_domain: null, verified_github_org: null })).toBe(false);
    expect(isVerifiedPublisher({ verified_domain: "acme.example", verified_github_org: null })).toBe(true);
    expect(isVerifiedPublisher({ verified_domain: null, verified_github_org: "acme" })).toBe(true);
  });

  it("limits an account under 7 days old with no promoted pack to 3 dry-runs", () => {
    expect(dryRunCap({ ageMs: 2 * DAY, hasPromotedPack: false })).toBe(3);
    expect(dryRunCap({ ageMs: 2 * DAY, hasPromotedPack: true })).toBe(20);
    expect(dryRunCap({ ageMs: 7 * DAY, hasPromotedPack: false })).toBe(20);
    expect(dryRunCap({ ageMs: 7 * DAY - 1, hasPromotedPack: false })).toBe(3);
    expect(isYoungAccount({ ageMs: 0, hasPromotedPack: true })).toBe(false);
  });

  it("tells a refused publisher the cap and when the count starts again", () => {
    expect(capMessage("dry-runs", 20, Date.UTC(2026, 9, 22, 12))).toBe("dry-runs is capped at 20 a day; the count starts again at 2026-10-23T00:00:00.000Z");
  });
});

describe("nextRunStart", () => {
  const now = 1_000_000;
  it("starts a publisher under the limit at once", () => {
    expect(nextRunStart({ now, softLimited: false, latestGrantedStart: now + 5 * SOFT_RATE_LIMIT_INTERVAL_MS })).toBe(now);
  });
  it("starts a soft-limited publisher ten minutes after the later of now and the latest start granted", () => {
    expect(nextRunStart({ now, softLimited: true, latestGrantedStart: null })).toBe(now + SOFT_RATE_LIMIT_INTERVAL_MS);
    expect(nextRunStart({ now, softLimited: true, latestGrantedStart: now - 3_600_000 })).toBe(now + SOFT_RATE_LIMIT_INTERVAL_MS);
    expect(nextRunStart({ now, softLimited: true, latestGrantedStart: now + SOFT_RATE_LIMIT_INTERVAL_MS })).toBe(now + 2 * SOFT_RATE_LIMIT_INTERVAL_MS);
  });
});

describe("checkIntegrity", () => {
  it("passes bytes within 3 MiB that begin a zstd frame and hash to the declared value", async () => {
    const bytes = zstd(1024);
    const sha = await sha256Hex(bytes);
    expect(await checkIntegrity(stored(bytes), sha, sha256Hex)).toEqual({ ok: true, sha256: sha });
    const exact = zstd(MAX_UPLOAD_BYTES);
    expect(await checkIntegrity(stored(exact), await sha256Hex(exact), sha256Hex)).toMatchObject({ ok: true });
  });

  it("fails the cheapest check first and reads nothing it does not need", async () => {
    let reads = 0;
    const counting = { size: MAX_UPLOAD_BYTES + 1, read: async () => (reads++, zstd(10)) };
    expect(await checkIntegrity(counting, "0".repeat(64), sha256Hex)).toEqual({ ok: false, reason: "integrity.oversize" });
    expect(reads).toBe(0);
    expect(await checkIntegrity(stored(zstd(MAX_UPLOAD_BYTES + 1)), "0".repeat(64), sha256Hex)).toEqual({ ok: false, reason: "integrity.oversize" });
    expect(await checkIntegrity(stored(Uint8Array.from([0x1f, 0x8b, 8, 0, 1, 2])), "0".repeat(64), sha256Hex)).toEqual({ ok: false, reason: "integrity.not_zstd" });
    expect(await checkIntegrity(stored(zstd(64)), "0".repeat(64), sha256Hex)).toEqual({ ok: false, reason: "integrity.sha256_mismatch" });
  });

  it("does not take a skippable frame or a short object for a zstd archive", () => {
    expect(hasZstdMagic(Uint8Array.from([0x50, 0x2a, 0x4d, 0x18]))).toBe(false);
    expect(hasZstdMagic(Uint8Array.from([0x28, 0xb5, 0x2f]))).toBe(false);
    expect(hasZstdMagic(new Uint8Array())).toBe(false);
  });

  it("treats an object that vanished between its size and its read as a fault, not a verdict", async () => {
    await expect(checkIntegrity(stored(null, 10), "0".repeat(64), sha256Hex)).rejects.toThrow(/disappeared/);
  });
});

describe("dryRunStagingKey", () => {
  it("lives under the scope's staging prefix but apart from any version's object", () => {
    const key = dryRunStagingKey("acme", "gcp", "1.0.0", "c1");
    expect(key).toBe("staging/acme/dry-run/gcp/1.0.0/c1.tar.zst");
    expect(key.startsWith(stagingPrefix("acme"))).toBe(true);
  });
});
