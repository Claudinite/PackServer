import { FakeClock, FakeKV } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { migratedD1 } from "../../identity/testing.ts";
import {
  activeBlocks, blockSource, createFlagCache, FLAG_DEFS, flagDef, flagMac, isSourceBlocked, launchMirrorCurrent, LAUNCH_FLAG, LAUNCH_MIRROR_KEY, mirrorLaunch,
  NEW_PACK_KILL_SWITCH, overdueFlags, releasesSince, unblockSource, validFlagValue, verifyFlagMac, writeFlag, STAGED_PUBLISHING_THRESHOLD, CN_MIN_ADOPT_VERSION,
} from "../index.ts";

const KEY = "admin-only-key";
const fixture = () => {
  const { d1 } = migratedD1();
  const clock = new FakeClock(Date.parse("2026-10-26T12:00:00Z"));
  return { d1, clock, ports: { d1, clock } };
};

describe("flag registry", () => {
  it("names the flags the spec names, with compiled defaults", () => {
    expect(flagDef(LAUNCH_FLAG)?.default).toBe(false);
    expect(flagDef(CN_MIN_ADOPT_VERSION)?.default).toBeNull();
    expect(flagDef(STAGED_PUBLISHING_THRESHOLD)?.default).toBe(100);
    expect(flagDef(NEW_PACK_KILL_SWITCH)?.security).toBe(true);
  });

  it("holds each flag to the shape of its value", () => {
    const version = flagDef(CN_MIN_ADOPT_VERSION)!;
    expect(validFlagValue(version, "1.2.3")).toBe(true);
    expect(validFlagValue(version, "latest")).toBe(false);
    expect(validFlagValue(flagDef(STAGED_PUBLISHING_THRESHOLD)!, 2.5)).toBe(false);
    expect(validFlagValue(flagDef(LAUNCH_FLAG)!, null)).toBe(false);
    expect(validFlagValue(flagDef(LAUNCH_FLAG)!, "yes")).toBe(false);
  });

  it("gives every flag a retirement plan: permanent with a reason, or removal within two releases of being fully on", () => {
    for (const def of FLAG_DEFS) {
      if ("permanent" in def.retire) expect(def.retire.permanent.length, def.key).toBeGreaterThan(10);
      else expect(def.retire.fullyOnIn === null || /^\d+\.\d+\.\d+$/.test(def.retire.fullyOnIn), def.key).toBe(true);
    }
  });

  it("fails a flag that stayed past two releases once fully on", () => {
    const old = { ...FLAG_DEFS[3], retire: { fullyOnIn: "0.4.0" } };
    expect(overdueFlags([old], "0.5.0")).toEqual([]);
    expect(overdueFlags([old], "0.6.0")).toEqual([]);
    expect(overdueFlags([old], "0.7.0")).toEqual([old.key]);
    expect(releasesSince("1.2.3", "1.2.3")).toBe(0);
  });

  // The lint over the repository's own registry: a flag in the code today must not be overdue at the version the repository is at.
  it("holds no flag past its removal window at the package version", async () => {
    const { default: pkg } = (await import("../../../../package.json", { with: { type: "json" } })) as { default: { version: string } };
    expect(overdueFlags(FLAG_DEFS, pkg.version)).toEqual([]);
  });
});

describe("flag reads", () => {
  it("reads compiled defaults when the table is empty", async () => {
    const { ports } = fixture();
    const flags = await createFlagCache().read(ports);
    expect(flags.get(LAUNCH_FLAG)).toBe(false);
    expect(flags.get(STAGED_PUBLISHING_THRESHOLD)).toBe(100);
    expect(flags.source(LAUNCH_FLAG)).toBe("default");
  });

  it("reads the table once per 60 s and sees a change after it", async () => {
    const { ports, clock } = fixture();
    const cache = createFlagCache();
    expect((await cache.read(ports)).get(LAUNCH_FLAG)).toBe(false);
    await writeFlag(ports, LAUNCH_FLAG, true, null);
    clock.advance(59_000);
    expect((await cache.read(ports)).get(LAUNCH_FLAG)).toBe(false);
    clock.advance(1_000);
    expect((await cache.read(ports)).get(LAUNCH_FLAG)).toBe(true);
  });

  it("sees a writer's own change at once after invalidation", async () => {
    const { ports } = fixture();
    const cache = createFlagCache();
    await cache.read(ports);
    await writeFlag(ports, LAUNCH_FLAG, true, null);
    cache.invalidate();
    expect((await cache.read(ports)).get(LAUNCH_FLAG)).toBe(true);
  });

  it("keeps the last read when the table cannot be read", async () => {
    const { ports, clock, d1 } = fixture();
    const cache = createFlagCache();
    await writeFlag(ports, LAUNCH_FLAG, true, null);
    expect((await cache.read(ports)).get(LAUNCH_FLAG)).toBe(true);
    clock.advance(61_000);
    const broken = { ...ports, d1: { ...d1, query: async () => { throw new Error("D1 unavailable"); } } };
    expect((await cache.read(broken as never)).get(LAUNCH_FLAG)).toBe(true);
  });

  it("falls back to the defaults when it never could read", async () => {
    const { clock } = fixture();
    const d1 = { query: async () => { throw new Error("D1 unavailable"); }, batch: async () => [] };
    const flags = await createFlagCache().read({ d1, clock } as never);
    expect(flags.get(NEW_PACK_KILL_SWITCH)).toBe(false);
    expect(flags.readAt).toBeNull();
  });
});

describe("security flags", () => {
  it("are written only with the admin-only key", async () => {
    const { ports } = fixture();
    expect(await writeFlag(ports, NEW_PACK_KILL_SWITCH, true, null)).toEqual({ ok: false, reason: "mac_key_missing" });
    expect(await writeFlag(ports, NEW_PACK_KILL_SWITCH, true, KEY)).toMatchObject({ ok: true, value: true });
  });

  it("are honoured only when the row's MAC verifies under the reader's key", async () => {
    const { ports, d1 } = fixture();
    await writeFlag(ports, NEW_PACK_KILL_SWITCH, true, KEY);
    const read = (key: string | null) => createFlagCache().read(ports, key);
    expect((await read(KEY)).get(NEW_PACK_KILL_SWITCH)).toBe(true);
    expect((await read(KEY)).source(NEW_PACK_KILL_SWITCH)).toBe("stored");
    const other = await read("another-key");
    expect(other.get(NEW_PACK_KILL_SWITCH)).toBe(false);
    expect(other.source(NEW_PACK_KILL_SWITCH)).toBe("unverified");
    expect((await read(null)).source(NEW_PACK_KILL_SWITCH)).toBe("unverified");

    // A row written straight into the table, with no MAC, is not honoured either.
    await d1.query("update feature_flags set mac = null where key = ?", [NEW_PACK_KILL_SWITCH]);
    expect((await read(KEY)).get(NEW_PACK_KILL_SWITCH)).toBe(false);
  });

  it("are not hidden from a keyed reader by an earlier read without the key", async () => {
    const { ports } = fixture();
    await writeFlag(ports, NEW_PACK_KILL_SWITCH, true, KEY);
    const cache = createFlagCache();
    expect((await cache.read(ports)).source(NEW_PACK_KILL_SWITCH)).toBe("unverified");
    expect((await cache.read(ports, KEY)).get(NEW_PACK_KILL_SWITCH)).toBe(true);
    expect((await cache.read(ports)).source(NEW_PACK_KILL_SWITCH)).toBe("unverified");
  });

  it("do not move to another key or time with their MAC", async () => {
    const mac = await flagMac(KEY, NEW_PACK_KILL_SWITCH, "true", "2026-10-26T12:00:00.000Z");
    const row = { key: NEW_PACK_KILL_SWITCH, value: "true", updated_at: "2026-10-26T12:00:00.000Z", mac };
    expect(await verifyFlagMac(KEY, row)).toBe(true);
    expect(await verifyFlagMac(KEY, { ...row, key: "index_regeneration_frozen" })).toBe(false);
    expect(await verifyFlagMac(KEY, { ...row, value: "false" })).toBe(false);
    expect(await verifyFlagMac(KEY, { ...row, updated_at: "2026-10-26T12:00:01.000Z" })).toBe(false);
    expect(await verifyFlagMac(KEY, { ...row, mac: "nonsense" })).toBe(false);
  });

  it("refuse an unknown flag and a value of the wrong shape", async () => {
    const { ports } = fixture();
    expect(await writeFlag(ports, "shadow.blocking", true, KEY)).toEqual({ ok: false, reason: "unknown_flag" });
    expect(await writeFlag(ports, LAUNCH_FLAG, "yes" as never, null)).toEqual({ ok: false, reason: "invalid_value" });
  });
});

describe("launch mirror", () => {
  it("writes the key explicitly in both states", async () => {
    const kv = new FakeKV(new FakeClock());
    await mirrorLaunch(kv, false);
    expect(await kv.get(LAUNCH_MIRROR_KEY)).toBe("false");
    expect(await launchMirrorCurrent(kv, false)).toBe(true);
    await mirrorLaunch(kv, true);
    expect(await kv.get(LAUNCH_MIRROR_KEY)).toBe("true");
    expect(await launchMirrorCurrent(kv, false)).toBe(false);
  });
});

describe("blocked sources", () => {
  it("blocks until lifted, or until the block expires", async () => {
    const { ports, clock } = fixture();
    await blockSource(ports, { source: "ip:abc", reason: "credential stuffing", by: "admin@example.test" });
    await blockSource(ports, { source: "ip:def", reason: "burst", by: "judge", hours: 24 });
    expect(await isSourceBlocked(ports, "ip:abc")).toBe(true);
    expect(await isSourceBlocked(ports, "ip:def")).toBe(true);
    expect(await isSourceBlocked(ports, "ip:other")).toBe(false);
    clock.advance(25 * 3_600_000);
    expect(await isSourceBlocked(ports, "ip:def")).toBe(false);
    expect((await activeBlocks(ports)).map((b) => b.source)).toEqual(["ip:abc"]);
    expect(await unblockSource(ports, "ip:abc")).toBe(true);
    expect(await unblockSource(ports, "ip:abc")).toBe(false);
    expect(await isSourceBlocked(ports, "ip:abc")).toBe(false);
  });
});
