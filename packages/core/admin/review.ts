import { extractArchive } from "../canonical/index.ts";
import { notifyOwners } from "../scopes/proofs/context.ts";
import { iso } from "../scopes/personal.ts";
import { verificationFacts } from "../scopes/verified-publisher.ts";
import { compareThreePart } from "../validation/manifest/index.ts";
import { diffTrees, type TreeDiff } from "./diff.ts";
import { actorOf, MAX_REASON, type AdminIdentity, type AdminPorts } from "./ports.ts";
import { adminReport, readJson, type AdminReportView } from "./report.ts";

export interface Standing {
  /** A Verified Publisher whose proof is live. */
  verified: boolean;
  /** Public repositories the latest completed weekly scan found declaring the pack; null until a scan has completed. */
  declared_by: number | null;
}

export interface HeldVersion {
  run_id: string;
  scope: string;
  pack: string;
  version: string;
  held_at: string;
  standing: Standing;
}

export interface Appeal {
  run_id: string;
  pack: string;
  version: string;
  note: string;
  submitted_at: string;
  state: "open" | "upheld" | "denied";
}

type Ports = Pick<AdminPorts, "d1">;

async function standingOf(d1: AdminPorts["d1"], scopeId: string, pack: string): Promise<Standing> {
  const facts = await verificationFacts(d1, scopeId);
  const scan = (await d1.query("select id from adoption_scans where completed_at is not null order by completed_at desc, id desc limit 1")).rows[0];
  const declared = scan
    ? Number((await d1.query("select count(distinct repository) as n from pack_declarations where scan_id = ? and pack = ?", [scan.id, pack])).rows[0]?.n ?? 0)
    : null;
  return { verified: facts?.verified === true, declared_by: declared };
}

/** Standing first, then declaring repositories, then age: nothing here resolves by timeout. */
export const byStanding = (a: HeldVersion, b: HeldVersion): number =>
  Number(b.standing.verified) - Number(a.standing.verified) ||
  (b.standing.declared_by ?? 0) - (a.standing.declared_by ?? 0) ||
  a.held_at.localeCompare(b.held_at) ||
  a.run_id.localeCompare(b.run_id);

/** Versions whose run ended in a hold and that no admin has decided (REQ-VAL-013). */
export async function heldVersions(ports: Ports): Promise<HeldVersion[]> {
  const { rows } = await ports.d1.query(
    `select r.id, r.version, r.pack_name, r.scope_id, r.finished_at, r.created_at, s.name as scope
     from validation_runs r join scopes s on s.id = r.scope_id
     where r.kind = 'publish' and r.synthetic = 0 and r.status = 'finished' and r.verdict = 'hold'
       and not exists (select 1 from review_decisions d where d.run_id = r.id)`,
  );
  const held: HeldVersion[] = [];
  for (const r of rows) {
    const pack = `@${r.scope}/${r.pack_name}`;
    held.push({
      run_id: String(r.id),
      scope: String(r.scope),
      pack,
      version: String(r.version),
      held_at: String(r.finished_at ?? r.created_at),
      standing: await standingOf(ports.d1, String(r.scope_id), pack),
    });
  }
  return held.sort(byStanding);
}

/** Appeals no admin has answered yet, oldest first. */
export async function openAppeals(ports: Ports): Promise<Appeal[]> {
  const { rows } = await ports.d1.query(
    `select a.run_id, a.note, a.submitted_at, a.state, r.version, r.pack_name, s.name as scope
     from review_appeals a join validation_runs r on r.id = a.run_id join scopes s on s.id = r.scope_id
     where a.state = 'open' order by a.submitted_at, a.run_id`,
  );
  return rows.map(appealRow);
}

const appealRow = (r: Record<string, unknown>): Appeal => ({
  run_id: String(r.run_id),
  pack: `@${r.scope}/${r.pack_name}`,
  version: String(r.version),
  note: String(r.note),
  submitted_at: String(r.submitted_at),
  state: r.state as Appeal["state"],
});

export interface CapabilityChange {
  added: string[];
  removed: string[];
  /** The version gains a capability that waits for the owner's passkey (REQ-VAL-052). */
  widening: boolean;
}

export interface HeldDetail {
  run_id: string;
  report: AdminReportView | null;
  /** The previous promoted version the diff is taken against; null when there is none, and every file then reads as added. */
  against: { version: string; run_id: string } | null;
  diff: TreeDiff | null;
  capabilities: CapabilityChange;
  appeal: Appeal | null;
}

interface RunRow {
  id: string;
  scope_id: string;
  pack_name: string;
  version: string;
  scope: string;
  report_key: string | null;
  canonical_key: string | null;
  widening: boolean;
  verdict: string | null;
  workflow_instance_id: string | null;
  decidable: boolean;
}

async function loadRun(ports: Ports, runId: string): Promise<RunRow | null> {
  const r = (
    await ports.d1.query(
      `select r.id, r.scope_id, r.pack_name, r.version, r.report_key, r.canonical_key, r.widening, r.verdict, r.workflow_instance_id, r.kind, r.synthetic, r.status, s.name as scope
       from validation_runs r join scopes s on s.id = r.scope_id where r.id = ?`,
      [runId],
    )
  ).rows[0];
  return r
    ? {
        id: String(r.id),
        scope_id: String(r.scope_id),
        pack_name: String(r.pack_name),
        version: String(r.version),
        scope: String(r.scope),
        report_key: (r.report_key as string | null) ?? null,
        canonical_key: (r.canonical_key as string | null) ?? null,
        widening: r.widening === 1 || r.widening === true,
        verdict: (r.verdict as string | null) ?? null,
        workflow_instance_id: (r.workflow_instance_id as string | null) ?? null,
        decidable: r.kind === "publish" && !r.synthetic && r.status === "finished",
      }
    : null;
}

async function previousPromoted(ports: Ports, run: RunRow): Promise<{ version: string; run_id: string; canonical_key: string } | null> {
  const { rows } = await ports.d1.query(
    `select r.id, r.version, r.canonical_key from validation_runs r
     join packs p on p.scope_id = r.scope_id and p.name = r.pack_name
     join pack_versions pv on pv.pack_id = p.id and pv.version = r.version and pv.published_at is not null
     where r.scope_id = ? and r.pack_name = ? and r.kind = 'publish' and r.status = 'finished' and r.verdict in ('pass', 'warn') and r.canonical_key is not null
     order by r.finished_at desc, r.id desc`,
    [run.scope_id, run.pack_name],
  );
  const best = new Map<string, { version: string; run_id: string; canonical_key: string }>();
  for (const r of rows) {
    const version = String(r.version);
    if (compareThreePart(version, run.version) < 0 && !best.has(version)) best.set(version, { version, run_id: String(r.id), canonical_key: String(r.canonical_key) });
  }
  return [...best.values()].sort((a, b) => compareThreePart(b.version, a.version))[0] ?? null;
}

async function capabilitiesOf(bucket: AdminPorts["validationReports"], runId: string): Promise<string[]> {
  const a = (await readJson(bucket, `runs/${runId}/sandbox-a.json`)) as { capabilities?: { capabilities?: unknown } | null } | null;
  const list = a?.capabilities?.capabilities;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string").sort() : [];
}

/** One held version as the admin opens it: the diff against the previous promoted version, the capability changes and the findings with their quotes. */
export async function heldDetail(ports: Pick<AdminPorts, "d1" | "validationReports">, runId: string): Promise<HeldDetail | null> {
  const run = await loadRun(ports, runId);
  if (!run) return null;
  const previous = await previousPromoted(ports, run);
  const now = run.canonical_key ? await ports.validationReports.get(run.canonical_key) : null;
  const before = previous ? await ports.validationReports.get(previous.canonical_key) : null;
  const diff = now ? diffTrees(before ? await extractArchive(before, { canonical: true }) : null, await extractArchive(now, { canonical: true })) : null;
  const had = new Set(previous ? await capabilitiesOf(ports.validationReports, previous.run_id) : []);
  const has = new Set(await capabilitiesOf(ports.validationReports, run.id));
  const appealRowFound = (
    await ports.d1.query(
      `select a.run_id, a.note, a.submitted_at, a.state, r.version, r.pack_name, s.name as scope
       from review_appeals a join validation_runs r on r.id = a.run_id join scopes s on s.id = r.scope_id where a.run_id = ?`,
      [runId],
    )
  ).rows[0];
  return {
    run_id: run.id,
    report: await adminReport(ports.validationReports, run.id, run.report_key),
    against: previous ? { version: previous.version, run_id: previous.run_id } : null,
    diff,
    capabilities: { added: [...has].filter((c) => !had.has(c)), removed: [...had].filter((c) => !has.has(c)), widening: run.widening },
    appeal: appealRowFound ? appealRow(appealRowFound) : null,
  };
}

export type ReviewDecision = { kind: "approve" } | { kind: "reject"; reason: string } | { kind: "quarantine_publisher"; reason?: string };

export type ReviewResult =
  | { ok: true; pack: string; version: string }
  | { ok: false; reason: "unknown" | "not_held" | "already_decided" | "reason_required" | "reason_too_long"; message: string };

const EVENT_TYPE = "review";

async function sendEvent(ports: AdminPorts, instance: string | null, payload: unknown): Promise<boolean> {
  if (!instance) return false;
  try {
    await ports.workflows.sendEvent(instance, { type: EVENT_TYPE, payload });
    return true;
  } catch (error) {
    console.log(JSON.stringify({ event: "admin.review_event_unsent", instance, reason: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

type DecisionStep = "audited_at" | "event_sent_at" | "notified_at";

/** Runs `step` once across retries: the first caller to set the column does the work, and a step that throws gives the claim back. */
async function claimed(ports: AdminPorts, runId: string, column: DecisionStep, step: () => Promise<unknown>, quiet = false): Promise<void> {
  const won = await ports.d1.query(`update review_decisions set ${column} = ? where run_id = ? and ${column} is null`, [iso(ports), runId]);
  if (won.meta.changes === 0) return;
  try {
    await step();
  } catch (error) {
    await ports.d1.query(`update review_decisions set ${column} = null where run_id = ?`, [runId]);
    if (!quiet) throw error;
  }
}

/**
 * Records the decision first: the row, not the event, is what a run decided while no instance waits resumes from
 * (REQ-VAL-013). The event only wakes an instance that is waiting.
 */
export async function decideHeld(ports: AdminPorts, runId: string, admin: AdminIdentity, decision: ReviewDecision): Promise<ReviewResult> {
  const run = await loadRun(ports, runId);
  if (!run) return { ok: false, reason: "unknown", message: "No such run." };
  if (run.verdict !== "hold" || !run.decidable) return { ok: false, reason: "not_held", message: "The run is not held for review." };
  const reason = decision.kind === "approve" ? null : (decision.reason ?? "").trim() || null;
  if (decision.kind === "reject" && !reason) return { ok: false, reason: "reason_required", message: "A rejection needs a reason." };
  if (reason && reason.length > MAX_REASON) return { ok: false, reason: "reason_too_long", message: `A reason is at most ${MAX_REASON} characters.` };
  const pack = `@${run.scope}/${run.pack_name}`;
  const at = iso(ports);
  const statements = [
    { sql: "insert or ignore into review_decisions (run_id, decision, reason, decided_by, decided_at) values (?, ?, ?, ?, ?)", params: [runId, decision.kind, reason, admin.email, at] },
    ...(decision.kind === "quarantine_publisher"
      ? [{ sql: "update scopes set state = 'held' where id = ? and exists (select 1 from review_decisions where run_id = ? and decision = 'quarantine_publisher' and audited_at is null)", params: [run.scope_id, runId] }]
      : []),
  ];
  await ports.d1.batch(statements);
  const recorded = (await ports.d1.query("select decision, decided_by from review_decisions where run_id = ?", [runId])).rows[0];
  if (!recorded || recorded.decision !== decision.kind || recorded.decided_by !== admin.email) return { ok: false, reason: "already_decided", message: "The run is already decided." };

  // Each step after the row is claimed before it runs, so a retry of a step that stopped part way finishes it and concurrent retries do not repeat it.
  await claimed(ports, runId, "audited_at", () => ports.audit(actorOf(admin), "admin.action", `version:${pack}@${run.version}`, { detail: { verb: `review.${decision.kind}` } }));
  await claimed(ports, runId, "event_sent_at", async () => {
    if (!(await sendEvent(ports, run.workflow_instance_id, { run_id: runId, decision: decision.kind }))) throw new Error("no waiting instance took the event");
  }, true);
  const appealUrl = `https://${new URL(ports.siteOrigin).host}/validation/${runId}`;
  if (decision.kind === "reject") {
    await claimed(ports, runId, "notified_at", () => notifyOwners(ports, run.scope_id, "pack-actioned", { pack: `${pack}@${run.version}`, action: "rejected after review", reason: reason!, appealUrl }));
  }
  if (decision.kind === "quarantine_publisher") {
    await claimed(ports, runId, "notified_at", () =>
      notifyOwners(ports, run.scope_id, "pack-actioned", {
        pack: `${pack}@${run.version}`,
        action: "held, and publishing under this name is suspended",
        reason: reason ?? "An admin suspended publishing under this name after review.",
        appealUrl,
      }),
    );
  }
  return { ok: true, pack, version: run.version };
}

export type AppealResult =
  | { ok: true; pack: string; version: string }
  | { ok: false; reason: "unknown" | "not_open"; message: string };

/** Upholding resumes the run at promotion without validating it again; denying is final. */
export async function decideAppeal(ports: AdminPorts, runId: string, admin: AdminIdentity, outcome: "upheld" | "denied"): Promise<AppealResult> {
  const run = await loadRun(ports, runId);
  const found = run && (await ports.d1.query("select state from review_appeals where run_id = ?", [runId])).rows[0];
  if (!run || !found) return { ok: false, reason: "unknown", message: "No such appeal." };
  const at = iso(ports);
  const changed = await ports.d1.query("update review_appeals set state = ?, decided_by = ?, decided_at = ? where run_id = ? and state = 'open'", [outcome, admin.email, at, runId]);
  if (changed.meta.changes === 0) return { ok: false, reason: "not_open", message: "The appeal is already decided." };
  const pack = `@${run.scope}/${run.pack_name}`;
  await ports.audit(actorOf(admin), "admin.action", `version:${pack}@${run.version}`, { detail: { verb: `appeal.${outcome}` } });
  if (await sendEvent(ports, run.workflow_instance_id, { run_id: runId, appeal: outcome })) {
    await ports.d1.query("update review_appeals set event_sent_at = ? where run_id = ?", [iso(ports), runId]);
  }
  await notifyOwners(ports, run.scope_id, "appeal-decided", { pack: `${pack}@${run.version}`, outcome, packUrl: `https://${new URL(ports.siteOrigin).host}/validation/${runId}` });
  return { ok: true, pack, version: run.version };
}
