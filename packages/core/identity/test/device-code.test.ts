import { describe, expect, it } from "vitest";
import { createFakePorts } from "@packserver/ports/fakes";
import { migratedD1 } from "../testing.ts";
import {
  approveDeviceRequest, authenticateDeviceToken, DEVICE_CODE_TTL_MS, denyDeviceRequest, describeDeviceRequest, looksLikeUserCode,
  normalizeUserCode, pollDeviceCode, startDeviceAuthorization,
} from "../device-code.ts";
import { createSession, destroySession, rotateSession, type SessionPorts } from "../sessions.ts";

const SECOND = 1000;
const device = { label: "Firefox on Linux", country: "NO" };

function setup() {
  const fakes = createFakePorts();
  const { d1, db } = migratedD1();
  db.exec("insert into users (id, created_at) values ('u1', '2026-10-22T00:00:00.000Z')");
  const ports: SessionPorts = { kv: fakes.kv.SESSIONS_KV!, d1, clock: fakes.clock, rng: fakes.rng };
  return { fakes, ports };
}

async function approved() {
  const { fakes, ports } = setup();
  const started = await startDeviceAuthorization(ports, { country: "se" });
  const session = await createSession(ports, { user_id: "u1", device });
  expect(await approveDeviceRequest(ports, started.user_code, session)).toBe(true);
  fakes.clock.advance(started.interval * SECOND);
  return { fakes, ports, started, session };
}

describe("IT-PRIV-017 device code", () => {
  it("hands out a typeable user code and a separate secret device code", async () => {
    const { ports } = setup();
    const started = await startDeviceAuthorization(ports, { country: "SE" });
    expect(looksLikeUserCode(started.user_code)).toBe(true);
    expect(started.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.device_code).toMatch(/^[0-9a-f]{64}$/);
    expect(started.expires_in).toBe(DEVICE_CODE_TTL_MS / SECOND);
  });

  it("reads a typed code however it is spaced or cased", async () => {
    const { ports } = setup();
    const started = await startDeviceAuthorization(ports, { country: "SE" });
    const sloppy = started.user_code.toLowerCase().replace("-", "  ");
    expect(normalizeUserCode(sloppy)).toBe(normalizeUserCode(started.user_code));
    expect(await describeDeviceRequest(ports, sloppy)).toMatchObject({ country: "SE" });
    expect(await describeDeviceRequest(ports, "AAAA-AAAA")).toBeNull();
    expect(await describeDeviceRequest(ports, "nonsense")).toBeNull();
  });

  it("records an unknown country as unknown, never as a guess", async () => {
    const { ports } = setup();
    const started = await startDeviceAuthorization(ports, { country: "" });
    expect(await describeDeviceRequest(ports, started.user_code)).toMatchObject({ country: "unknown" });
  });

  it("answers pending, then slow_down when polled early and grows the interval", async () => {
    const { fakes, ports } = setup();
    const started = await startDeviceAuthorization(ports, { country: "SE" });
    expect(await pollDeviceCode(ports, started.device_code)).toEqual({ kind: "pending" });
    expect(await pollDeviceCode(ports, started.device_code)).toEqual({ kind: "slow_down" });
    fakes.clock.advance(started.interval * SECOND);
    expect(await pollDeviceCode(ports, started.device_code)).toEqual({ kind: "slow_down" });
    fakes.clock.advance(started.interval * SECOND * 3);
    expect(await pollDeviceCode(ports, started.device_code)).toEqual({ kind: "pending" });
  });

  it("exchanges an approved code once for a token that ends with the approving session", async () => {
    const { fakes, ports, started, session } = await approved();
    const granted = await pollDeviceCode(ports, started.device_code);
    expect(granted.kind).toBe("granted");
    if (granted.kind !== "granted") return;
    expect(granted.token).toMatch(/^psr_[0-9a-f]{64}$/);
    expect(await authenticateDeviceToken(ports, granted.token)).toEqual({ user_id: "u1", expires_at: session.record.expires_at });
    expect(await pollDeviceCode(ports, started.device_code)).toEqual({ kind: "invalid" });
    fakes.clock.advance(session.record.expires_at - fakes.clock.now());
    expect(await authenticateDeviceToken(ports, granted.token)).toBeNull();
  });

  it("answers a denied code as denied and issues nothing", async () => {
    const { fakes, ports } = setup();
    const started = await startDeviceAuthorization(ports, { country: "SE" });
    expect(await denyDeviceRequest(ports, started.user_code)).toBe(true);
    fakes.clock.advance(started.interval * SECOND);
    expect(await pollDeviceCode(ports, started.device_code)).toEqual({ kind: "denied" });
    expect(await describeDeviceRequest(ports, started.user_code)).toBeNull();
  });

  it("expires an unanswered code after fifteen minutes and refuses a late answer", async () => {
    const { fakes, ports } = setup();
    const started = await startDeviceAuthorization(ports, { country: "SE" });
    fakes.clock.advance(DEVICE_CODE_TTL_MS);
    const session = await createSession(ports, { user_id: "u1", device });
    expect(await approveDeviceRequest(ports, started.user_code, session)).toBe(false);
    expect(await pollDeviceCode(ports, started.device_code)).toEqual({ kind: "expired" });
    expect(await pollDeviceCode(ports, started.device_code)).toEqual({ kind: "invalid" });
  });

  it("answers a second approval of the same code as unknown", async () => {
    const { ports, started, session } = await approved();
    expect(await approveDeviceRequest(ports, started.user_code, session)).toBe(false);
    expect(await denyDeviceRequest(ports, started.user_code)).toBe(false);
  });

  it("refuses values that are not tokens", async () => {
    const { ports } = setup();
    expect(await authenticateDeviceToken(ports, "psr_")).toBeNull();
    expect(await authenticateDeviceToken(ports, `psr_${"0".repeat(64)}`)).toBeNull();
  });

  it("ends a token when its session is destroyed, and keeps it through a rotation", async () => {
    const { ports, started, session } = await approved();
    const granted = await pollDeviceCode(ports, started.device_code);
    if (granted.kind !== "granted") throw new Error("not granted");
    const rotated = await rotateSession(ports, session);
    expect(await authenticateDeviceToken(ports, granted.token)).not.toBeNull();
    await destroySession(ports, rotated);
    expect(await authenticateDeviceToken(ports, granted.token)).toBeNull();
  });
});
