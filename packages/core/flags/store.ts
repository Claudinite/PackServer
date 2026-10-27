import type { Clock, D1 } from "@packserver/ports";
import { flagDef, validFlagValue, type FlagValue } from "./defs.ts";
import { flagMac } from "./mac.ts";

export interface FlagRow {
  key: string;
  value: string;
  security: boolean;
  updated_at: string;
  mac: string | null;
}

export async function loadFlagRows(d1: D1): Promise<FlagRow[]> {
  const { rows } = await d1.query("select key, value, security, updated_at, mac from feature_flags");
  return rows.map((r) => ({ key: String(r.key), value: String(r.value), security: Number(r.security) === 1, updated_at: String(r.updated_at), mac: r.mac === null ? null : String(r.mac) }));
}

export type WriteFlagResult =
  | { ok: true; key: string; value: FlagValue; previous: FlagValue | undefined }
  | { ok: false; reason: "unknown_flag" | "invalid_value" | "mac_key_missing" };

/** Writes a flag the registry names. A security flag is written with its MAC, and without the admin-only key it is not written. */
export async function writeFlag(ports: { d1: D1; clock: Clock }, key: string, value: FlagValue, macSecret: string | null): Promise<WriteFlagResult> {
  const def = flagDef(key);
  if (!def) return { ok: false, reason: "unknown_flag" };
  if (!validFlagValue(def, value)) return { ok: false, reason: "invalid_value" };
  if (def.security && !macSecret) return { ok: false, reason: "mac_key_missing" };
  const at = new Date(ports.clock.now()).toISOString();
  const stored = JSON.stringify(value);
  const mac = def.security && macSecret ? await flagMac(macSecret, key, stored, at) : null;
  const before = (await ports.d1.query("select value from feature_flags where key = ?", [key])).rows[0];
  await ports.d1.query(
    `insert into feature_flags (key, value, security, updated_at, mac) values (?, ?, ?, ?, ?)
     on conflict (key) do update set value = excluded.value, security = excluded.security, updated_at = excluded.updated_at, mac = excluded.mac`,
    [key, stored, def.security ? 1 : 0, at, mac],
  );
  return { ok: true, key, value, previous: before ? (JSON.parse(String(before.value)) as FlagValue) : undefined };
}
