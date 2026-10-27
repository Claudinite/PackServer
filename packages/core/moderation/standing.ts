import type { D1 } from "@packserver/ports";
import { hasVerifiedAdoption } from "../community/adoption.ts";
import { verificationFacts } from "../scopes/verified-publisher.ts";
import { DISMISSALS_FOR_LOSS, REPORTER_MIN_AGE_MS, STANDING_LOSS_MS, STANDING_REPORTERS, STANDING_SCAN, STANDING_SCAN_PAGES, WIDELY_DECLARED } from "./constants.ts";
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

/** A reporter whose reports were dismissed twice cannot count toward a hold until 90 days after the second dismissal. */
export async function lostStanding(d1: D1, userId: string, nowMs: number): Promise<boolean> {
  const { rows } = await d1.query("select 1 from abuse_standing_losses where reporter_id = ? and lost_at > ?", [userId, isoOf(nowMs - STANDING_LOSS_MS)]);
  return rows.length > 0;
}

/** Called as dismissals land: the second inside the window, counted from the last loss, starts a new loss. */
export async function recordDismissals(d1: D1, reporterIds: readonly string[], nowMs: number): Promise<void> {
  for (const userId of reporterIds) {
    if (await lostStanding(d1, userId, nowMs)) continue;
    const { rows } = await d1.query(
      `select count(*) as n from abuse_reports where reporter_id = ? and state = 'dismissed' and decided_at > ?
         and decided_at > coalesce((select lost_at from abuse_standing_losses where reporter_id = ?), '')`,
      [userId, isoOf(nowMs - STANDING_LOSS_MS), userId],
    );
    if (Number(rows[0]?.n ?? 0) >= DISMISSALS_FOR_LOSS) {
      await d1.query("insert into abuse_standing_losses (reporter_id, lost_at) values (?, ?) on conflict (reporter_id) do update set lost_at = excluded.lost_at", [userId, isoOf(nowMs)]);
    }
  }
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

export type Grounds = "verified_publisher" | "reporters";

/**
 * Which standing, if any, holds the version on the open prioritised reports it has now: never when the declaring count
 * is unknown or above 100. Blocked reporters count for nothing, and the look stops at the first grounds it finds or
 * after a bounded number of reporters.
 */
export async function groundsFor(d1: D1, pack: PackInfo, version: string, declared: number | null, nowMs: number): Promise<Grounds | null> {
  if (declared === null || declared > WIDELY_DECLARED) return null;
  let counted = 0;
  let after = "";
  for (let page = 0; page < STANDING_SCAN_PAGES; page += 1) {
    const { rows } = await d1.query(
      `select distinct reporter_id from abuse_reports
       where pack_id = ? and version = ? and target_kind = 'pack' and state = 'open' and collapsed_into is null and prioritised_at is not null
         and reporter_id > ? and reporter_id not in (select reporter_id from abuse_reporter_blocks)
       order by reporter_id limit ?`,
      [pack.id, version, after, STANDING_SCAN],
    );
    for (const row of rows) {
      const standing = await standingOf(d1, String(row.reporter_id), pack, nowMs);
      if (standing === "verified_publisher") return "verified_publisher";
      if (standing === "established") counted += 1;
      if (counted >= STANDING_REPORTERS) return "reporters";
    }
    if (rows.length < STANDING_SCAN) break;
    after = String(rows[rows.length - 1]!.reporter_id);
  }
  return null;
}
