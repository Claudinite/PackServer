import type { D1 } from "@packserver/ports";
import type { AuditActor } from "../audit/index.ts";
import { completedAttrs, heldAttrs } from "./signals.ts";
import { notifyOwners, notifyUser } from "./notify.ts";
import { nowIso, publicUrl, type ModerationPorts } from "./ports.ts";
import { restoreVersion } from "./transition.ts";
import type { PackInfo } from "./targets.ts";

export type ActionKind = "quarantine" | "yank" | "dmca_removal";
export type ActionTrigger = "report_standing" | "judge" | "admin" | "dmca";

const WHAT: Record<ActionKind, string> = { quarantine: "quarantined", yank: "yanked", dmca_removal: "removed after a copyright notice" };

type Ports = Pick<ModerationPorts, "d1" | "clock" | "rng" | "mail" | "emit" | "siteOrigin" | "reindex">;

interface OpenReport {
  id: string;
  reporter_id: string;
  prioritised: boolean;
  head: boolean;
}

async function openReports(d1: D1, where: string, params: unknown[]): Promise<OpenReport[]> {
  const { rows } = await d1.query(`select id, reporter_id, prioritised_at, collapsed_into from abuse_reports where state = 'open' and ${where} order by created_at, id`, params);
  return rows.map((r) => ({ id: String(r.id), reporter_id: String(r.reporter_id), prioritised: r.prioritised_at !== null, head: r.collapsed_into === null }));
}

/**
 * Closes the reports and tells each reporter the outcome and nothing more (REQ-MOD-015). A prioritised report that a
 * person decided stops the judge's hour.
 */
async function settle(ports: Ports, reports: readonly OpenReport[], outcome: "actioned" | "dismissed", by: string, label: string, path: string): Promise<void> {
  if (reports.length === 0) return;
  const at = nowIso(ports);
  await ports.d1.batch(reports.map((r) => ({ sql: "update abuse_reports set state = ?, decided_by = ?, decided_at = ? where id = ? and state = 'open'", params: [outcome, by, at, r.id] })));
  for (const r of reports) if (r.prioritised) ports.emit("moderation.takedown_completed", completedAttrs(r.id));
  for (const reporter of new Set(reports.map((r) => r.reporter_id))) {
    await notifyUser(ports, reporter, "abuse-report-outcome", { target: label, outcome: outcome === "actioned" ? "actioned" : "closed", url: publicUrl(ports, path) });
  }
}

const versionWhere = "pack_id = ? and version = ? and target_kind = 'pack'";

/** The reports on one version a decision settles. */
export async function settleVersionReports(ports: Ports, pack: PackInfo, version: string, outcome: "actioned" | "dismissed", by: string): Promise<void> {
  await settle(ports, await openReports(ports.d1, versionWhere, [pack.id, version]), outcome, by, pack.name, `/packs/${pack.name}`);
}

/** The reports on one review or profile a decision settles. */
export async function settleTargetReports(ports: Ports, kind: "review" | "profile", targetId: string, outcome: "actioned" | "dismissed", by: string): Promise<void> {
  await settle(ports, await openReports(ports.d1, "target_kind = ? and target_id = ?", [kind, targetId]), outcome, by, `a ${kind}`, "/");
}

export interface RecordedAction {
  id: string;
}

/**
 * Records that moderation moved a version out of reach, tells the publisher with an appeal link, and tells the judge. A
 * person's action also settles the open reports on the version; a hold the registry placed itself leaves them for a person.
 */
export async function recordAction(
  ports: Ports,
  input: { pack: PackInfo; version: string; kind: ActionKind; reason: string; trigger: ActionTrigger; actor: AuditActor },
): Promise<RecordedAction> {
  const id = ports.rng.uuid();
  const actor = input.actor.id ?? "system";
  await ports.d1.query(
    "insert into moderation_actions (id, pack_id, version, kind, reason, trigger, actor, taken_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.pack.id, input.version, input.kind, input.reason, input.trigger, actor, nowIso(ports)],
  );
  await notifyOwners(ports, input.pack.scope_id, "pack-actioned", {
    pack: `${input.pack.name}@${input.version}`,
    action: WHAT[input.kind],
    reason: input.reason,
    appealUrl: publicUrl(ports, `/appeals/${id}`),
  });
  const pending = await openReports(ports.d1, versionWhere, [input.pack.id, input.version]);
  if (input.trigger === "admin") {
    await settle(ports, pending, "actioned", actor, input.pack.name, `/packs/${input.pack.name}`);
  } else {
    for (const r of pending) if (r.prioritised) ports.emit("moderation.quarantined", heldAttrs({ id: r.id, pack: input.pack.name, version: input.version }, input.trigger === "judge" ? "takedown_timer" : "abuse_standing"));
  }
  return { id };
}

/** Marks an action undone when its version returned, whatever brought it back. */
export async function markRestored(ports: Pick<Ports, "d1" | "clock">, packId: string, version: string): Promise<void> {
  await ports.d1.query("update moderation_actions set restored_at = ? where pack_id = ? and version = ? and restored_at is null", [nowIso(ports), packId, version]);
}

/** Holds the registry placed before a person looked at the report come off when a person dismisses it. */
export async function liftProvisionalHolds(ports: Ports, pack: PackInfo, version: string): Promise<void> {
  const { rows } = await ports.d1.query(
    "select id from moderation_actions where pack_id = ? and version = ? and kind = 'quarantine' and trigger in ('judge', 'report_standing') and restored_at is null",
    [pack.id, version],
  );
  if (rows.length === 0) return;
  await restoreVersion(ports, pack.name, version);
  await markRestored(ports, pack.id, version);
}
