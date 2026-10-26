import { sha256Hex, type Clock, type D1 } from "@packserver/ports";
import type { SessionDevice } from "./sessions.ts";

export interface DevicePorts {
  d1: D1;
  clock: Clock;
}

/**
 * Records the device a sign-in came from. It is new when the person has signed in before from
 * other devices only; a first-ever sign-in is not a surprise to anyone.
 */
export async function noteSignInDevice(ports: DevicePorts, userId: string, device: SessionDevice): Promise<{ isNew: boolean }> {
  const fingerprint = await sha256Hex(`device:${device.label}|${device.country}`);
  const at = new Date(ports.clock.now()).toISOString();
  const [seen, any] = await ports.d1.batch([
    { sql: "select 1 from known_devices where user_id = ? and fingerprint = ?", params: [userId, fingerprint] },
    { sql: "select 1 from known_devices where user_id = ? limit 1", params: [userId] },
  ]);
  if (seen!.rows.length > 0) {
    await ports.d1.query("update known_devices set last_seen_at = ? where user_id = ? and fingerprint = ?", [at, userId, fingerprint]);
    return { isNew: false };
  }
  await ports.d1.query(
    "insert or ignore into known_devices (user_id, fingerprint, label, country, first_seen_at, last_seen_at) values (?, ?, ?, ?, ?, ?)",
    [userId, fingerprint, device.label, device.country, at, at],
  );
  return { isNew: any!.rows.length > 0 };
}
