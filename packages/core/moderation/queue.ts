import type { D1 } from "@packserver/ports";
import type { AuditActor } from "../audit/index.ts";
import { hideReview } from "../community/reviews.ts";
import { liftProvisionalHolds, markRestored, recordAction, settleTargetReports, settleVersionReports, type ActionKind } from "./actions.ts";
import { moderationReason } from "./constants.ts";
import { notifyOwners } from "./notify.ts";
import { publicUrl, type ModerationPorts } from "./ports.ts";
import { findPack, findPackById } from "./targets.ts";
import { transitionVersion } from "./transition.ts";

export interface QueuedAbuse {
  id: string;
  target_kind: "pack" | "review" | "profile";
  /** The pack, review id or scope. */
  target: string;
  pack: string | null;
  version: string | null;
  category: string;
  /** A high-severity report on a pack: first in the queue, hour counted. */
  priority: boolean;
  /** Identical reports collapsed into this one, itself included. */
  count: number;
  created_at: string;
  prioritised_at: string | null;
}

/** Open reports, prioritised ones first and then oldest first; identical reports show once with their count. */
export async function openAbuseReports(d1: D1): Promise<QueuedAbuse[]> {
  const { rows } = await d1.query(
    `select r.id, r.target_kind, r.target_id, r.version, r.category, r.created_at, r.prioritised_at,
       (select count(*) from abuse_reports c where c.collapsed_into = r.id) + 1 as n,
       case when p.id is null then null else '@' || s.name || '/' || p.name end as pack
     from abuse_reports r left join packs p on p.id = r.pack_id left join scopes s on s.id = p.scope_id
     where r.state = 'open' and r.collapsed_into is null
     order by r.prioritised_at is null, r.prioritised_at, r.created_at, r.id`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    target_kind: r.target_kind as QueuedAbuse["target_kind"],
    target: r.target_kind === "pack" ? String(r.pack) : String(r.target_id),
    pack: r.pack === null ? null : String(r.pack),
    version: r.version === null ? null : String(r.version),
    category: String(r.category),
    priority: r.prioritised_at !== null,
    count: Number(r.n),
    created_at: String(r.created_at),
    prioritised_at: r.prioritised_at === null ? null : String(r.prioritised_at),
  }));
}

interface Head {
  id: string;
  target_kind: "pack" | "review" | "profile";
  target_id: string;
  pack_id: string | null;
  version: string | null;
}

async function openHead(d1: D1, id: string): Promise<Head | null> {
  const r = (await d1.query("select id, target_kind, target_id, pack_id, version, collapsed_into from abuse_reports where id = ? and state = 'open'", [id])).rows[0];
  if (!r) return null;
  const headId = r.collapsed_into === null ? String(r.id) : String(r.collapsed_into);
  const h = headId === r.id ? r : (await d1.query("select id, target_kind, target_id, pack_id, version from abuse_reports where id = ?", [headId])).rows[0]!;
  return { id: String(h.id), target_kind: h.target_kind as Head["target_kind"], target_id: String(h.target_id), pack_id: h.pack_id === null ? null : String(h.pack_id), version: h.version === null ? null : String(h.version) };
}

export type DismissResult = { ok: true } | { ok: false; reason: "unknown" };

/**
 * A person finds nothing wrong: the report and every report collapsed into it close, their reporters count a dismissal,
 * and a hold the registry placed on its own comes off.
 */
export async function dismissAbuse(ports: ModerationPorts, id: string, admin: string): Promise<DismissResult> {
  const head = await openHead(ports.d1, id);
  if (!head) return { ok: false, reason: "unknown" };
  const pack = head.pack_id ? await findPackById(ports.d1, head.pack_id) : null;
  if (head.target_kind === "pack" && pack && head.version) {
    await settleVersionReports(ports, pack, head.version, "dismissed", admin);
    await liftProvisionalHolds(ports, pack, head.version);
  } else if (head.target_kind !== "pack") {
    await settleTargetReports(ports, head.target_kind, head.target_id, "dismissed", admin);
  }
  await ports.audit({ kind: "admin", id: admin }, "admin.action", `abuse:${head.id}`, { detail: { verb: "abuse.dismiss" } });
  return { ok: true };
}

export type MoveResult = { ok: true; changed: boolean } | { ok: false; message: string };

/**
 * A person moves one version out of reach. This is the one path for the admin app's taps, the judge's hold and the queue:
 * the status changes, the index re-signs, the publisher is told with an appeal link and the action is recorded.
 */
export async function moveVersion(
  ports: ModerationPorts,
  actor: AuditActor,
  input: { pack: string; version: string; transition: "quarantine" | "yank" | "unquarantine"; reason: string },
): Promise<MoveResult> {
  const stored = input.transition === "yank" ? moderationReason(input.reason) : input.reason;
  const moved = await transitionVersion(ports, input.transition, { pack: input.pack, version: input.version, reason: stored });
  if (!moved.ok) return { ok: false, message: moved.message };
  const pack = await findPack(ports.d1, input.pack);
  if (!pack || !moved.changed) return { ok: true, changed: false };
  if (input.transition === "unquarantine") await markRestored(ports, pack.id, input.version);
  else {
    const kind: ActionKind = input.transition === "yank" ? "yank" : "quarantine";
    await recordAction(ports, { pack, version: input.version, kind, reason: stored, trigger: actor.kind === "admin" ? "admin" : "judge", actor });
  }
  return { ok: true, changed: true };
}

/** Quarantines every version of a pack that can still be held. */
export async function quarantinePack(ports: ModerationPorts, actor: AuditActor, packName: string, reason: string): Promise<MoveResult & { versions?: string[] }> {
  const pack = await findPack(ports.d1, packName);
  if (!pack) return { ok: false, message: `${packName} is not a pack.` };
  const { rows } = await ports.d1.query("select version from pack_versions where pack_id = ? and state in ('active', 'deprecated') order by published_at, version", [pack.id]);
  const versions: string[] = [];
  for (const row of rows) {
    const moved = await moveVersion(ports, actor, { pack: pack.name, version: String(row.version), transition: "quarantine", reason });
    if (moved.ok && moved.changed) versions.push(String(row.version));
  }
  return { ok: true, changed: versions.length > 0, versions };
}

/** Takes a pack to the bottom of search results and out of the exploration slot until it is restored. */
export async function hidePack(ports: Pick<ModerationPorts, "d1">, packName: string): Promise<MoveResult> {
  const pack = await findPack(ports.d1, packName);
  if (!pack) return { ok: false, message: `${packName} is not a pack.` };
  const changed = await ports.d1.query("update pack_search set demotion = 'abuse_hold' where pack_id = ? and (demotion is null or demotion <> 'abuse_hold')", [pack.id]);
  return { ok: true, changed: changed.meta.changes > 0 };
}

/** A moderator takes a review down with a reason; reports on it close as actioned. */
export async function hideReviewByModerator(ports: ModerationPorts, admin: string, reviewId: string, reason: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await hideReview(ports, reviewId, reason);
  if (!result.ok) return { ok: false, message: result.reason === "hidden" ? "The review is already hidden." : "There is no such review." };
  await settleTargetReports(ports, "review", reviewId, "actioned", admin);
  return { ok: true };
}

/** Holds publishing under the scope's name; the publisher is told. */
export async function suspendPublisher(ports: ModerationPorts, admin: string, scopeName: string, reason: string): Promise<{ ok: true; changed: boolean } | { ok: false; message: string }> {
  const scope = (await ports.d1.query("select id, state from scopes where name = ?", [scopeName.replace(/^@/, "")])).rows[0];
  if (!scope) return { ok: false, message: `${scopeName} is not a scope.` };
  if (scope.state === "held") return { ok: true, changed: false };
  await ports.d1.query("update scopes set state = 'held' where id = ?", [scope.id]);
  await notifyOwners(ports, String(scope.id), "pack-actioned", { pack: `@${scopeName.replace(/^@/, "")}`, action: "suspended from publishing", reason, appealUrl: publicUrl(ports, "/") });
  await settleTargetReports(ports, "profile", String(scope.id), "actioned", admin);
  return { ok: true, changed: true };
}

export type AbuseAction = { action: "quarantine" | "yank"; reason: string } | { action: "hide_review"; reason: string } | { action: "suspend"; reason: string };
export type ActResult = { ok: true } | { ok: false; reason: "unknown" | "wrong_target" | "failed"; message: string };

/** A person acts on a report: the version is held or yanked, the review taken down or the publisher suspended; the report and its collapsed copies settle. */
export async function actOnAbuse(ports: ModerationPorts, admin: string, id: string, decision: AbuseAction): Promise<ActResult> {
  const head = await openHead(ports.d1, id);
  if (!head) return { ok: false, reason: "unknown", message: "No open report by that id." };
  const actor = { kind: "admin" as const, id: admin };
  if (decision.action === "quarantine" || decision.action === "yank") {
    const pack = head.pack_id ? await findPackById(ports.d1, head.pack_id) : null;
    if (head.target_kind !== "pack" || !pack || !head.version) return { ok: false, reason: "wrong_target", message: "Only a report on a pack version can be held or yanked." };
    const moved = await moveVersion(ports, actor, { pack: pack.name, version: head.version, transition: decision.action, reason: decision.reason });
    if (!moved.ok) return { ok: false, reason: "failed", message: moved.message };
    // A version a person had to look at again, because it was already out of reach, still settles its reports.
    if (!moved.changed) await settleVersionReports(ports, pack, head.version, "actioned", admin);
    await ports.audit(actor, "admin.action", `version:${pack.name}@${head.version}`, { detail: { verb: `version.${decision.action}`, reason: decision.reason } });
    return { ok: true };
  }
  if (decision.action === "hide_review") {
    if (head.target_kind !== "review") return { ok: false, reason: "wrong_target", message: "Only a report on a review can take the review down." };
    const hidden = await hideReviewByModerator(ports, admin, head.target_id, decision.reason);
    if (!hidden.ok) return { ok: false, reason: "failed", message: hidden.message };
    await ports.audit(actor, "admin.action", `review:${head.target_id}`, { detail: { verb: "review.hide", reason: decision.reason } });
    return { ok: true };
  }
  if (head.target_kind !== "profile") return { ok: false, reason: "wrong_target", message: "Only a report on a profile can suspend its publisher." };
  const name = (await ports.d1.query("select name from scopes where id = ?", [head.target_id])).rows[0]?.name;
  const suspended = await suspendPublisher(ports, admin, String(name), decision.reason);
  if (!suspended.ok) return { ok: false, reason: "failed", message: suspended.message };
  await ports.audit(actor, "admin.action", `scope:@${String(name)}`, { detail: { verb: "publisher.suspend", reason: decision.reason } });
  return { ok: true };
}
