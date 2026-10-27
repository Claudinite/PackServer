import { z } from "zod";
import { COMMENT_HIDE_AFTER_MS, COMMENTS_PER_DAY, DAY_MS, MAX_COMMENT_CHARS, MAX_SECTION_COMMENTS } from "./constants.ts";
import { isoOf, nowMs, type CommunityPorts } from "./ports.ts";
import { isEstablished, type PackRef } from "./standing.ts";
import { countedCutoff } from "./tallies.ts";

export const CommentInput = z.object({
  section: z.string().min(1).max(512),
  version: z.string().min(1).max(64),
  body: z.string().trim().min(1).max(MAX_COMMENT_CHARS),
});
export type CommentInput = z.infer<typeof CommentInput>;

export const VoteInput = z.object({ value: z.union([z.literal(1), z.literal(-1)]) });

export interface CommentView {
  id: string;
  section: string;
  version: string;
  author: string | null;
  body: string;
  created_at: string;
  /** Votes that count (REQ-COMM-002): the account is a day old and holds no role in the pack's scope. */
  up: number;
  down: number;
  /** Net-negative for 3 days or more: a reader finds it behind a disclosure. */
  hidden: boolean;
  /** The viewer's own vote, counted or not. */
  mine?: 1 | -1 | null;
  /** The prose screen held this comment; only its author sees it. */
  held?: true;
}

export type CommentRefusal = { ok: false; reason: "young_account" | "daily_limit" | "not_found" | "own_comment"; message: string };
const refuse = (reason: CommentRefusal["reason"], message: string): CommentRefusal => ({ ok: false, reason, message });

const SELECT = (withMine: boolean) => `
  select c.id as id, c.section as section, c.version as version, c.user_id as user_id, u.handle as author, c.body as body, c.created_at as created_at, c.held_at as held_at,
    coalesce(sum(case when cv.value = 1 and vu.created_at <= ?1 and cv.user_id <> c.user_id and not exists (select 1 from scope_members m where m.scope_id = ?2 and m.user_id = cv.user_id) then 1 else 0 end), 0) as up,
    coalesce(sum(case when cv.value = -1 and vu.created_at <= ?1 and cv.user_id <> c.user_id and not exists (select 1 from scope_members m where m.scope_id = ?2 and m.user_id = cv.user_id) then 1 else 0 end), 0) as down
    ${withMine ? ", (select value from comment_votes where comment_id = c.id and user_id = ?3) as mine" : ""}
  from comments c join users u on u.id = c.user_id
    left join comment_votes cv on cv.comment_id = c.id left join users vu on vu.id = cv.user_id`;

function toView(row: Record<string, unknown>, now: number, viewer: string | undefined): CommentView {
  const up = Number(row.up);
  const down = Number(row.down);
  const age = now - Date.parse(String(row.created_at));
  return {
    id: String(row.id),
    section: String(row.section),
    version: String(row.version),
    author: row.author === null || row.author === undefined ? null : String(row.author),
    body: String(row.body),
    created_at: String(row.created_at),
    up,
    down,
    hidden: up - down < 0 && age >= COMMENT_HIDE_AFTER_MS,
    ...(viewer === undefined ? {} : { mine: row.mine === null || row.mine === undefined ? null : (Number(row.mine) as 1 | -1) }),
    ...(row.held_at === null || row.held_at === undefined ? {} : { held: true as const }),
  };
}

/** The comments on one section, oldest first. A held comment appears only to its author. */
export async function listComments(ports: CommunityPorts, pack: PackRef, viewerId: string | undefined, section: string): Promise<CommentView[]> {
  const now = nowMs(ports);
  const { rows } = await ports.d1.query(
    `${SELECT(true)} where c.pack_id = ?4 and c.section = ?5 and (c.held_at is null or c.user_id = ?3) group by c.id order by c.created_at, c.id limit ${MAX_SECTION_COMMENTS}`,
    [countedCutoff(now), pack.scope_id, viewerId ?? "", pack.id, section],
  );
  return rows.map((r) => toView(r, now, viewerId));
}

/** Comments per section for a pack, held ones left out; the Contents tab shows the figure on a collapsed section. */
export async function commentCounts(ports: Pick<CommunityPorts, "d1">, pack: Pick<PackRef, "id">): Promise<Record<string, number>> {
  const { rows } = await ports.d1.query("select section, count(*) as n from comments where pack_id = ? and held_at is null group by section", [pack.id]);
  return Object.fromEntries(rows.map((r) => [String(r.section), Number(r.n)]));
}

/**
 * Comments follow the account rules of reviews: an account under 24 hours old cannot comment (REQ-COMM-005) and an account
 * is limited to 10 comments a day. `held` is the prose screen's verdict, decided by the caller.
 */
export async function postComment(
  ports: CommunityPorts, pack: PackRef, userId: string, input: CommentInput, held: boolean,
): Promise<{ ok: true; comment: CommentView } | CommentRefusal> {
  const { d1 } = ports;
  const now = nowMs(ports);
  if (!(await isEstablished(d1, userId, now))) return refuse("young_account", "Accounts under 24 hours old cannot comment yet.");
  const today = await d1.query("select count(*) as n from comments where user_id = ? and created_at > ?", [userId, isoOf(now - DAY_MS)]);
  if (Number(today.rows[0]?.n) >= COMMENTS_PER_DAY) return refuse("daily_limit", `You can post ${COMMENTS_PER_DAY} comments a day.`);
  const id = ports.rng.uuid();
  const at = isoOf(now);
  await d1.query("insert into comments (id, pack_id, section, version, user_id, body, created_at, held_at) values (?, ?, ?, ?, ?, ?, ?, ?)", [
    id, pack.id, input.section, input.version, userId, input.body, at, held ? at : null,
  ]);
  const comment = (await listComments(ports, pack, userId, input.section)).find((c) => c.id === id)!;
  return { ok: true, comment };
}

/**
 * Votes a comment up or down, or takes the vote back with `value: 0`. Anyone signed in may vote; whether the vote counts
 * is decided when it is read. A person does not vote on their own comment.
 */
export async function voteOnComment(
  ports: CommunityPorts, pack: PackRef, userId: string, commentId: string, value: 1 | -1 | 0,
): Promise<{ ok: true; comment: CommentView } | CommentRefusal> {
  const { rows } = await ports.d1.query("select user_id, section, held_at from comments where id = ? and pack_id = ?", [commentId, pack.id]);
  const row = rows[0];
  if (!row || (row.held_at && row.user_id !== userId)) return refuse("not_found", "There is no such comment.");
  if (row.user_id === userId) return refuse("own_comment", "You cannot vote on your own comment.");
  if (value === 0) await ports.d1.query("delete from comment_votes where comment_id = ? and user_id = ?", [commentId, userId]);
  else {
    await ports.d1.query(
      "insert into comment_votes (comment_id, user_id, value, voted_at) values (?, ?, ?, ?) on conflict (comment_id, user_id) do update set value = excluded.value, voted_at = excluded.voted_at",
      [commentId, userId, value, isoOf(nowMs(ports))],
    );
  }
  const comment = (await listComments(ports, pack, userId, String(row.section))).find((c) => c.id === commentId)!;
  return { ok: true, comment };
}
