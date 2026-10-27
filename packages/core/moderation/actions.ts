import type { D1 } from "@packserver/ports";
import type { AuditActor } from "../audit/index.ts";
import { declaredBy } from "./declared.ts";
import { completedAttrs, heldAttrs } from "./signals.ts";
import { notifyOwners, notifyUser } from "./notify.ts";
import { nowIso, publicUrl, type ModerationPorts } from "./ports.ts";
import { groundsFor, recordDismissals } from "./standing.ts";
import { undoAction, type Change } from "./status.ts";
import type { PackInfo } from "./targets.ts";

export type ActionKind = "quarantine" | "yank" | "dmca_removal" | "hide_pack" | "suspend";
export type ActionTrigger = "report_standing" | "judge" | "admin" | "dmca";

const WHAT: Record<ActionKind, string> = {
  quarantine: "quarantined",
  yank: "yanked",
  dmca_removal: "removed after a copyright notice",
  hide_pack: "hidden from search",
  suspend: "suspended from publishing",
};

type Ports = Pick<ModerationPorts, "d1" | "clock" | "rng" | "mail" | "emit" | "siteOrigin" | "reindex">;

interface OpenReport {
  id: string;
  reporter_id: string;
  prioritised: boolean;
}

async function openReports(d1: D1, where: string, params: unknown[]): Promise<OpenReport[]> {
  const { rows } = await d1.query(`select id, reporter_id, prioritised_at from abuse_reports where state = 'open' and ${where} order by created_at, id`, params);
  return rows.map((r) => ({ id: String(r.id), reporter_id: String(r.reporter_id), prioritised: r.prioritised_at !== null }));
}

/**
 * Closes the reports and tells each reporter the outcome and nothing more (REQ-MOD-015). A prioritised report that a
 * person decided stops the judge's hour; a dismissal counts against its reporter.
 */
async function settle(ports: Ports, reports: readonly OpenReport[], outcome: "actioned" | "dismissed", by: string, label: string, path: string): Promise<void> {
  if (reports.length === 0) return;
  const at = nowIso(ports);
  await ports.d1.batch(reports.map((r) => ({ sql: "update abuse_reports set state = ?, decided_by = ?, decided_at = ? where id = ? and state = 'open'", params: [outcome, by, at, r.id] })));
  for (const r of reports) if (r.prioritised) ports.emit("moderation.takedown_completed", completedAttrs(r.id));
  const reporters = [...new Set(reports.map((r) => r.reporter_id))];
  if (outcome === "dismissed") await recordDismissals(ports.d1, reporters, ports.clock.now());
  for (const reporter of reporters) {
    await notifyUser(ports, reporter, "abuse-report-outcome", { target: label, outcome: outcome === "actioned" ? "actioned" : "closed", url: publicUrl(ports, path) });
  }
}

const versionWhere = "pack_id = ? and version = ? and target_kind = 'pack'";

/** The reports on one version a decision about the version settles. */
export async function settleVersionReports(ports: Ports, pack: PackInfo, version: string, outcome: "actioned" | "dismissed", by: string): Promise<void> {
  await settle(ports, await openReports(ports.d1, versionWhere, [pack.id, version]), outcome, by, pack.name, `/packs/${pack.name}`);
}

/** One report and the reports collapsed into it; no other report on the same version is touched. */
export async function settleReport(ports: Ports, pack: PackInfo | null, headId: string, outcome: "actioned" | "dismissed", by: string): Promise<void> {
  await settle(ports, await openReports(ports.d1, "(id = ? or collapsed_into = ?)", [headId, headId]), outcome, by, pack?.name ?? "a report", pack ? `/packs/${pack.name}` : "/");
}

/** The reports on one review or profile a decision settles. */
export async function settleTargetReports(ports: Ports, kind: "review" | "profile", targetId: string, outcome: "actioned" | "dismissed", by: string): Promise<void> {
  await settle(ports, await openReports(ports.d1, "target_kind = ? and target_id = ?", [kind, targetId]), outcome, by, `a ${kind}`, "/");
}

export interface RecordedAction {
  id: string;
}

export interface ActionInput {
  scope: { id: string; name: string };
  pack: PackInfo | null;
  version: string | null;
  kind: ActionKind;
  reason: string;
  trigger: ActionTrigger;
  actor: AuditActor;
  /** What the action replaced and wrote, which is what undoing it checks (a scope or demotion change gives only the states). */
  change: Change;
}

const labelOf = (input: ActionInput): string => (input.version && input.pack ? `${input.pack.name}@${input.version}` : (input.pack?.name ?? `@${input.scope.name}`));

/**
 * Records that moderation took something out of reach, tells the publisher with an appeal link, and tells the judge. A
 * person's action on a version also settles the open reports on it; a hold the registry placed itself leaves them for a
 * person.
 */
export async function recordAction(ports: Ports, input: ActionInput): Promise<RecordedAction> {
  const id = ports.rng.uuid();
  const actor = input.actor.id ?? "system";
  const { from, to } = input.trigger === "admin" && input.pack && input.version ? await supersedeProvisional(ports, input.pack, input.version, input.change) : input.change;
  await ports.d1.query(
    `insert into moderation_actions (id, scope_id, pack_id, version, kind, reason, trigger, actor, taken_at, from_state, from_reason, to_state, to_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.scope.id, input.pack?.id ?? null, input.version, input.kind, input.reason, input.trigger, actor, nowIso(ports), from.state, from.reason, to.state, to.reason],
  );
  await notifyOwners(ports, input.scope.id, "pack-actioned", { pack: labelOf(input), action: WHAT[input.kind], reason: input.reason, appealUrl: publicUrl(ports, `/appeals/${id}`) });
  if (input.pack && input.version) {
    const pending = await openReports(ports.d1, versionWhere, [input.pack.id, input.version]);
    if (input.trigger === "admin") {
      await settle(ports, pending, "actioned", actor, input.pack.name, `/packs/${input.pack.name}`);
    } else {
      for (const r of pending) if (r.prioritised) ports.emit("moderation.quarantined", heldAttrs({ id: r.id, pack: input.pack.name, version: input.version }, input.trigger === "judge" ? "takedown_timer" : "abuse_standing"));
    }
  }
  return { id };
}

/**
 * A person's decision replaces the registry's own provisional hold on the version: the decision then undoes to what the
 * hold found, and the hold is closed.
 */
async function supersedeProvisional(ports: Pick<Ports, "d1" | "clock">, pack: PackInfo, version: string, change: Change): Promise<Change> {
  const { rows } = await ports.d1.query(
    "select id, from_state, from_reason, to_state, to_reason from moderation_actions where pack_id = ? and version = ? and kind = 'quarantine' and trigger in ('judge', 'report_standing') and restored_at is null order by taken_at desc, id desc limit 1",
    [pack.id, version],
  );
  const hold = rows[0];
  if (!hold || hold.to_state !== change.from.state || hold.to_reason !== change.from.reason) return change;
  await markRestored(ports, String(hold.id));
  return { from: { state: hold.from_state === null ? null : String(hold.from_state), reason: hold.from_reason === null ? null : String(hold.from_reason) }, to: change.to };
}

/** Marks one action undone. */
export async function markRestored(ports: Pick<Ports, "d1" | "clock">, actionId: string): Promise<void> {
  await ports.d1.query("update moderation_actions set restored_at = ? where id = ? and restored_at is null", [nowIso(ports), actionId]);
}

/** Marks every action on a version undone when a person lifted its hold directly. */
export async function markVersionRestored(ports: Pick<Ports, "d1" | "clock">, packId: string, version: string): Promise<void> {
  await ports.d1.query("update moderation_actions set restored_at = ? where pack_id = ? and version = ? and restored_at is null and kind in ('quarantine', 'yank')", [nowIso(ports), packId, version]);
}

export interface ActionRow {
  id: string;
  kind: string;
  scope_id: string;
  pack_id: string | null;
  version: string | null;
  from_state: string | null;
  from_reason: string | null;
  to_state: string | null;
  to_reason: string | null;
}

export async function actionRow(d1: D1, id: string): Promise<ActionRow | null> {
  const r = (await d1.query("select id, kind, scope_id, pack_id, version, from_state, from_reason, to_state, to_reason from moderation_actions where id = ?", [id])).rows[0];
  if (!r) return null;
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return { id: String(r.id), kind: String(r.kind), scope_id: String(r.scope_id), pack_id: text(r.pack_id), version: text(r.version), from_state: text(r.from_state), from_reason: text(r.from_reason), to_state: text(r.to_state), to_reason: text(r.to_reason) };
}

/** Undoes one action and marks it so; whatever now holds the thing for another reason stays. */
export async function restoreAction(ports: Ports, id: string): Promise<boolean> {
  const row = await actionRow(ports.d1, id);
  if (!row) return false;
  const changed = await undoAction(ports, row);
  await markRestored(ports, id);
  return changed;
}

/**
 * Holds the registry placed before a person looked come off once a person's decision leaves nothing to justify them: a
 * judge hold while no prioritised report on the version is still open, a standing hold also when the reports left no
 * longer carry the standing that placed it.
 */
export async function liftProvisionalHolds(ports: Ports, pack: PackInfo, version: string): Promise<void> {
  const { rows } = await ports.d1.query(
    "select id, trigger from moderation_actions where pack_id = ? and version = ? and kind = 'quarantine' and trigger in ('judge', 'report_standing') and restored_at is null order by taken_at, id",
    [pack.id, version],
  );
  if (rows.length === 0) return;
  const remaining = (await ports.d1.query("select 1 from abuse_reports where pack_id = ? and version = ? and target_kind = 'pack' and state = 'open' and prioritised_at is not null limit 1", [pack.id, version])).rows.length > 0;
  const standing = remaining ? await groundsFor(ports.d1, pack, version, await declaredBy(ports.d1, pack.name), ports.clock.now()) : null;
  for (const row of rows) {
    if (remaining && (row.trigger === "judge" || standing !== null)) continue;
    await restoreAction(ports, String(row.id));
  }
}
