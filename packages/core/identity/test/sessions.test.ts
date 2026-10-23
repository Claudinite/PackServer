import { describe, expect, it } from "vitest";
import { createFakePorts } from "@packserver/ports/fakes";
import {
  createSession, describeDevice, destroySession, hashSessionId, LAST_SEEN_THROTTLE_MS, listSessions, readSession, rotateSession,
  SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, type SessionPorts,
} from "../sessions.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const device = { label: "Firefox on Linux", country: "NO" };

function setup() {
  const fakes = createFakePorts();
  const ports: SessionPorts = { kv: fakes.kv.SESSIONS_KV!, clock: fakes.clock, rng: fakes.rng };
  return { fakes, ports };
}

describe("IT-ACC-013 session lifetime", () => {
  it("expires after 12 hours idle, measured from the last recorded request", async () => {
    const { fakes, ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device });
    fakes.clock.advance(10 * MINUTE);
    expect(await readSession(ports, live.sid)).not.toBeNull();
    fakes.clock.advance(SESSION_IDLE_MS - 10 * MINUTE + MINUTE);
    expect(await readSession(ports, live.sid)).toBeNull();
  });

  it("keeps a session whose last request was inside the window", async () => {
    const { fakes, ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device });
    fakes.clock.advance(20 * MINUTE);
    expect(await readSession(ports, live.sid)).not.toBeNull();
    fakes.clock.advance(SESSION_IDLE_MS - 20 * MINUTE + MINUTE);
    expect(await readSession(ports, live.sid)).not.toBeNull();
  });

  it("writes last-seen at most once per throttle interval", async () => {
    const { fakes, ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device });
    const start = live.record.last_seen;
    fakes.clock.advance(LAST_SEEN_THROTTLE_MS - 1);
    expect((await readSession(ports, live.sid))!.record.last_seen).toBe(start);
    fakes.clock.advance(1);
    expect((await readSession(ports, live.sid))!.record.last_seen).toBe(start + LAST_SEEN_THROTTLE_MS);
  });

  it("ends at the absolute limit however active the person is", async () => {
    const { fakes, ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device });
    for (let t = 0; t < SESSION_ABSOLUTE_MS - 6 * HOUR; t += 6 * HOUR) {
      fakes.clock.advance(6 * HOUR);
      expect(await readSession(ports, live.sid), `at ${t}`).not.toBeNull();
    }
    fakes.clock.advance(6 * HOUR + MINUTE);
    expect(await readSession(ports, live.sid)).toBeNull();
  });

  it("forgets an expired session so its id never revives", async () => {
    const { fakes, ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device });
    fakes.clock.advance(SESSION_IDLE_MS);
    expect(await readSession(ports, live.sid)).toBeNull();
    expect(await ports.kv.list("")).toEqual([]);
  });
});

describe("IT-ACC-021 rotation and invalidation", () => {
  it("gives a rotated session a new id and refuses the old one, without moving the absolute limit", async () => {
    const { fakes, ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device });
    fakes.clock.advance(HOUR);
    const rotated = await rotateSession(ports, live, { mfa_at: fakes.clock.now() });
    expect(rotated.sid).not.toBe(live.sid);
    expect(await readSession(ports, live.sid)).toBeNull();
    const read = await readSession(ports, rotated.sid);
    expect(read!.record.expires_at).toBe(live.record.expires_at);
    expect(read!.record.mfa_at).toBe(fakes.clock.now());
    expect(read!.record.csrf_key).not.toBe(live.record.csrf_key);
    expect(await listSessions(ports, "u1")).toHaveLength(1);
  });

  it("refuses a destroyed session and anything that is not shaped like an id", async () => {
    const { ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device });
    await destroySession(ports, live);
    expect(await readSession(ports, live.sid)).toBeNull();
    expect(await readSession(ports, "short")).toBeNull();
    expect(await readSession(ports, `sess:${live.sid_hash}`)).toBeNull();
  });

  it("keeps the cookie value out of the store", async () => {
    const { ports } = setup();
    const live = await createSession(ports, { user_id: "u1", device });
    expect(live.sid_hash).toBe(await hashSessionId(live.sid));
    for (const key of await ports.kv.list("")) expect(key).not.toContain(live.sid);
  });
});

describe("listing", () => {
  it("lists a person's live sessions, newest activity first, marking the current one", async () => {
    const { fakes, ports } = setup();
    const laptop = await createSession(ports, { user_id: "u1", device });
    fakes.clock.advance(HOUR);
    const phone = await createSession(ports, { user_id: "u1", device: { label: "Safari on iOS", country: "NO" } });
    await createSession(ports, { user_id: "u2", device });
    const list = await listSessions(ports, "u1", laptop.sid_hash);
    expect(list.map((s) => [s.device.label, s.current])).toEqual([["Safari on iOS", false], ["Firefox on Linux", true]]);
    expect(list[0]!.id).toBe(phone.sid_hash);
  });
});

describe("describeDevice", () => {
  it("names browser and system, and tolerates what it cannot read", () => {
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "no")).toEqual({ label: "Firefox on Linux", country: "NO" });
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/604.1", undefined)).toEqual({ label: "Safari on iOS", country: "unknown" });
    expect(describeDevice(undefined, "XX1")).toEqual({ label: "Unknown device", country: "unknown" });
  });
});
