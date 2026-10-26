import { z } from "zod";
import { refreshPack } from "./aggregate.ts";
import { hasVerifiedAdoption } from "./adoption.ts";
import { MAX_REPLY_CHARS, MAX_REVIEW_CHARS, DAY_MS, REVIEWS_PER_DAY } from "./constants.ts";
import { isoOf, nowMs, type CommunityPorts } from "./ports.ts";
import { belongsToScope, isEstablished, isScopeOwner, type PackRef } from "./standing.ts";

export const ReviewInput = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().max(MAX_REVIEW_CHARS).default(""),
  version: z.string().min(1).max(64),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

export const ReplyInput = z.object({ body: z.string().trim().min(1).max(MAX_REPLY_CHARS) });

export interface ReviewView {
  id: string;
  rating: number;
  body: string;
  version: string;
  verified_adoption: boolean;
  author: string | null;
  created_at: string;
  updated_at: string;
  reply: { body: string; at: string } | null;
  /** Only a publisher reading the list sees whether a review was flagged. */
  flagged?: boolean;
}

export type Refused = { ok: false; reason: "young_account" | "own_pack" | "unknown_version" | "daily_limit" | "removed" | "not_found" | "forbidden" | "replied"; message: string };
export type ReviewResult = { ok: true; review: ReviewView; created: boolean } | Refused;

const refuse = (reason: Refused["reason"], message: string): Refused => ({ ok: false, reason, message });

const COLUMNS = `r.id as id, r.rating as rating, r.body as body, r.version as version, r.verified_adoption as verified_adoption, r.created_at as created_at,
  r.updated_at as updated_at, r.reply_body as reply_body, r.replied_at as replied_at, u.handle as author, f.review_id as flagged`;
const FROM = "from reviews r join users u on u.id = r.user_id left join review_flags f on f.review_id = r.id";

function toView(row: Record<string, unknown>, withFlag: boolean): ReviewView {
  return {
    id: String(row.id),
    rating: Number(row.rating),
    body: String(row.body),
    version: String(row.version),
    verified_adoption: Number(row.verified_adoption) === 1,
    author: row.author === null || row.author === undefined ? null : String(row.author),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    reply: row.reply_body === null ? null : { body: String(row.reply_body), at: String(row.replied_at) },
    ...(withFlag ? { flagged: row.flagged !== null && row.flagged !== undefined } : {}),
  };
}

/** The pack's reviews, newest first. Hidden ones are left out; reviews of a yanked or removed pack stay (REQ-COMM-013). */
export async function listReviews(ports: CommunityPorts, pack: PackRef, viewerId: string | undefined): Promise<ReviewView[]> {
  const { rows } = await ports.d1.query(`select ${COLUMNS} ${FROM} where r.pack_id = ? and r.hidden_at is null order by r.updated_at desc, r.id`, [pack.id]);
  const withFlag = viewerId !== undefined && (await isScopeOwner(ports.d1, pack, viewerId));
  return rows.map((r) => toView(r, withFlag));
}

export async function reviewOf(ports: CommunityPorts, pack: PackRef, userId: string): Promise<ReviewView | null> {
  const { rows } = await ports.d1.query(`select ${COLUMNS} ${FROM} where r.pack_id = ? and r.user_id = ? and r.hidden_at is null`, [pack.id, userId]);
  return rows[0] ? toView(rows[0], false) : null;
}

/**
 * One rating and review per account per pack; a second submission edits the first and records the version.
 * Refused for an account under 24 hours old, for the pack's own scope, and past 10 new reviews in a day.
 */
export async function submitReview(ports: CommunityPorts, pack: PackRef, userId: string, input: ReviewInput): Promise<ReviewResult> {
  const { d1 } = ports;
  const now = nowMs(ports);
  if (!(await isEstablished(d1, userId, now))) return refuse("young_account", "Accounts under 24 hours old cannot review yet.");
  if (await belongsToScope(d1, pack, userId)) return refuse("own_pack", "You cannot review your own packs or those of an org you belong to.");
  const version = await d1.query("select 1 from pack_versions where pack_id = ? and version = ?", [pack.id, input.version]);
  if (version.rows.length === 0) return refuse("unknown_version", `${pack.name} has no version ${input.version}.`);

  const existing = (await d1.query("select id, verified_adoption, hidden_at from reviews where pack_id = ? and user_id = ?", [pack.id, userId])).rows[0];
  if (existing?.hidden_at) return refuse("removed", "This review was removed and cannot be edited.");
  if (!existing) {
    const today = await d1.query("select count(*) as n from reviews where user_id = ? and created_at > ?", [userId, isoOf(now - DAY_MS)]);
    if (Number(today.rows[0]?.n) >= REVIEWS_PER_DAY) return refuse("daily_limit", `You can post ${REVIEWS_PER_DAY} reviews a day.`);
  }
  const at = isoOf(now);
  // The mark is earned when a review is written and kept: a later scan that no longer finds the declaration leaves it.
  const verified = Number(existing?.verified_adoption) === 1 || (await hasVerifiedAdoption(d1, userId, pack));
  if (existing) {
    await d1.query("update reviews set rating = ?, body = ?, version = ?, verified_adoption = ?, updated_at = ? where id = ?", [input.rating, input.body, input.version, verified ? 1 : 0, at, existing.id]);
  } else {
    await d1.query(
      "insert into reviews (id, pack_id, user_id, rating, body, version, verified_adoption, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [ports.rng.uuid(), pack.id, userId, input.rating, input.body, input.version, verified ? 1 : 0, at, at],
    );
  }
  await refreshPack(ports, pack.id);
  return { ok: true, review: (await reviewOf(ports, pack, userId))!, created: !existing };
}

async function reviewOnPack(ports: CommunityPorts, pack: PackRef, reviewId: string): Promise<{ id: string; reply_body: unknown } | null> {
  const { rows } = await ports.d1.query("select id, reply_body from reviews where id = ? and pack_id = ? and hidden_at is null", [reviewId, pack.id]);
  return rows[0] ? { id: String(rows[0].id), reply_body: rows[0].reply_body } : null;
}

/** The pack's owners and maintainers reply to a review once; the reply cannot be changed or removed. */
export async function replyToReview(ports: CommunityPorts, pack: PackRef, userId: string, reviewId: string, body: string): Promise<ReviewResult> {
  if (!(await isScopeOwner(ports.d1, pack, userId))) return refuse("forbidden", "Only the pack's owners and maintainers can reply.");
  const review = await reviewOnPack(ports, pack, reviewId);
  if (!review) return refuse("not_found", "There is no such review.");
  const { meta } = await ports.d1.query(
    "update reviews set reply_body = ?, reply_by = ?, replied_at = ? where id = ? and reply_body is null",
    [body, userId, isoOf(nowMs(ports)), reviewId],
  );
  if (meta.changes === 0) return refuse("replied", "This review already has a reply.");
  const { rows } = await ports.d1.query(`select ${COLUMNS} ${FROM} where r.id = ?`, [reviewId]);
  return { ok: true, review: toView(rows[0]!, true), created: false };
}

/** The pack's owners and maintainers ask a moderator to look at a review; flagging twice changes nothing. */
export async function flagReview(ports: CommunityPorts, pack: PackRef, userId: string, reviewId: string): Promise<{ ok: true } | Refused> {
  if (!(await isScopeOwner(ports.d1, pack, userId))) return refuse("forbidden", "Only the pack's owners and maintainers can flag a review.");
  if (!(await reviewOnPack(ports, pack, reviewId))) return refuse("not_found", "There is no such review.");
  await ports.d1.query("insert or ignore into review_flags (review_id, flagged_by, flagged_at) values (?, ?, ?)", [reviewId, userId, isoOf(nowMs(ports))]);
  return { ok: true };
}

export interface FlaggedReview {
  review_id: string;
  pack: string;
  rating: number;
  body: string;
  flagged_by: string;
  flagged_at: string;
}

/** Flags waiting for a moderator, oldest first. */
export async function openReviewFlags(ports: Pick<CommunityPorts, "d1">): Promise<FlaggedReview[]> {
  const { rows } = await ports.d1.query(
    `select f.review_id as review_id, '@' || s.name || '/' || p.name as pack, r.rating as rating, r.body as body, f.flagged_by as flagged_by, f.flagged_at as flagged_at
       from review_flags f join reviews r on r.id = f.review_id join packs p on p.id = r.pack_id join scopes s on s.id = p.scope_id
      where f.resolved_at is null and r.hidden_at is null order by f.flagged_at, f.review_id`,
  );
  return rows.map((r) => ({
    review_id: String(r.review_id), pack: String(r.pack), rating: Number(r.rating), body: String(r.body), flagged_by: String(r.flagged_by), flagged_at: String(r.flagged_at),
  }));
}

export type HideResult = { ok: true } | { ok: false; reason: "not_found" | "hidden" };

/**
 * A moderator takes a review down with a reason. The row stays, so a reader of the database still sees what was decided,
 * and the author is told why (REQ-COMM-012). Nothing here deletes a review (REQ-COMM-007).
 */
export async function hideReview(ports: CommunityPorts, reviewId: string, reason: string): Promise<HideResult> {
  const { rows } = await ports.d1.query(
    "select r.user_id as user_id, r.pack_id as pack_id, r.hidden_at as hidden_at, '@' || s.name || '/' || p.name as pack from reviews r join packs p on p.id = r.pack_id join scopes s on s.id = p.scope_id where r.id = ?",
    [reviewId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.hidden_at) return { ok: false, reason: "hidden" };
  const at = isoOf(nowMs(ports));
  await ports.d1.batch([
    { sql: "update reviews set hidden_at = ?, hidden_reason = ? where id = ?", params: [at, reason, reviewId] },
    { sql: "update review_flags set resolved_at = ? where review_id = ?", params: [at, reviewId] },
    {
      sql: "insert into community_notices (id, kind, user_id, data, created_at) values (?, 'review-removed', ?, ?, ?)",
      params: [ports.rng.uuid(), row.user_id, JSON.stringify({ pack: row.pack, reason, packPath: `/packs/${String(row.pack)}` }), at],
    },
  ]);
  await refreshPack(ports, String(row.pack_id));
  return { ok: true };
}

