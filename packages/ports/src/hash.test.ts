import { describe, expect, it } from "vitest";
import { deriveDayKey, hmacHex, ipHash, principalHash, sha256Hex } from "./hash";

describe("hash helpers", () => {
  it("hashes SHA-256 to known vectors", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches the RFC 4231 HMAC test case 2", async () => {
    expect(await hmacHex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("derives a different day key for each day and each master", async () => {
    const a = await deriveDayKey("master", "2026-10-22");
    expect(a).not.toBe(await deriveDayKey("master", "2026-10-23"));
    expect(a).not.toBe(await deriveDayKey("other", "2026-10-22"));
    expect(a).toBe(await deriveDayKey("master", "2026-10-22"));
  });

  it("rejects a malformed day", async () => {
    await expect(deriveDayKey("master", "22/10/2026")).rejects.toThrow("not a UTC date");
  });

  it("rejects an empty key rather than hashing under nothing", async () => {
    await expect(hmacHex("", "x")).rejects.toThrow("must not be empty");
  });

  it("ip_hash is stable within a day key, differs across keys and addresses, and never contains the address", async () => {
    const day1 = await deriveDayKey("master", "2026-10-22");
    const day2 = await deriveDayKey("master", "2026-10-23");
    const h = await ipHash(day1, "198.51.100.7");
    expect(h).toBe(await ipHash(day1, " 198.51.100.7 "));
    expect(h).not.toBe(await ipHash(day2, "198.51.100.7"));
    expect(h).not.toBe(await ipHash(day1, "198.51.100.8"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("198");
  });

  it("principal_hash separates kinds and keys", async () => {
    const h = await principalHash("k1", "user", "42");
    expect(h).not.toBe(await principalHash("k1", "token", "42"));
    expect(h).not.toBe(await principalHash("k2", "user", "42"));
    expect(h).not.toBe(await principalHash("k1", "user", "43"));
  });
});
