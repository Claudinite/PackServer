import type { D1 } from "@packserver/ports";
import { hasVerifiedAdoption } from "../community/adoption.ts";
import { verificationFacts } from "../scopes/verified-publisher.ts";
import { DISMISSALS_FOR_LOSS, REPORTER_MIN_AGE_MS, STANDING_LOSS_MS } from "./constants.ts";
import { isoOf } from "./ports.ts";
import type { PackInfo } from "./targets.ts";

export type Standing = "verified_publisher" | "established" | "none";

/** Whether the person owns a scope that holds Verified Publisher. A GitHub-org proof alone is not standing (REQ-MOD-009). */
async function ownsVerifiedScope(d1: D1, userId: string): Promise<boolean> {
  const { rows } = await d1.query("select scope_id from scope_members where user_id = ? and role = 'owner'", [userId]);
  for (const row of rows) if ((await verificationFacts(d1, String(row.scope_id)))?.verified === true) return true;
  return false;
}

async function hasPromotedPack(d1: D1, userId: string): Promise<boolean> {
  const { rows } = await d1.query(
    `select 1 from scope_members m join packs p on p.scope_id = m.scope_id join pack_versions v on v.pack_id = p.id
     where m.user_id = ? and m.role in ('owner', 'maintainer') and v.published_at is not null limit 1`,
    [userId],
  );
  return rows.length > 0;
}

/** Reporters whose reports were dismissed twice lose the ability to count toward a hold for 90 days. */
export async function lostStanding(d1: D1, userId: string, nowMs: number): Promise<boolean> {
  const { rows } = await d1.query("select count(*) as n from abuse_reports where reporter_id = ? and state = 'dismissed' and decided_at > ?", [userId, isoOf(nowMs - STANDING_LOSS_MS)]);
  return Number(rows[0]?.n ?? 0) >= DISMISSALS_FOR_LOSS;
}

/**
 * What a reporter's agreement is worth against a pack. A Verified Publisher owner counts alone; otherwise an account
 * older than 30 days with a verified adoption of the pack or a promoted pack of its own counts as one of three. A person
 * with a role in the pack's own scope counts for nothing.
 */
export async function standingOf(d1: D1, userId: string, pack: PackInfo, nowMs: number): Promise<Standing> {
  const member = await d1.query("select 1 from scope_members where scope_id = ? and user_id = ? limit 1", [pack.scope_id, userId]);
  if (member.rows.length > 0) return "none";
  if (await ownsVerifiedScope(d1, userId)) return "verified_publisher";
  const created = (await d1.query("select created_at from users where id = ?", [userId])).rows[0]?.created_at;
  if (typeof created !== "string" || nowMs - Date.parse(created) < REPORTER_MIN_AGE_MS) return "none";
  if (await lostStanding(d1, userId, nowMs)) return "none";
  return (await hasVerifiedAdoption(d1, userId, { id: pack.id, name: pack.name })) || (await hasPromotedPack(d1, userId)) ? "established" : "none";
}
