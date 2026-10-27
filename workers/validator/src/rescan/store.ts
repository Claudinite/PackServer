import { compareVersions } from "@packserver/core/index";
import { publicScopeOnly } from "@packserver/core/synthetic";
import type { D1 } from "@packserver/ports";
import type { RESCAN_KINDS } from "@packserver/schema/db";

export type PassKind = (typeof RESCAN_KINDS)[number];

/** A version a pass may visit: the newest eligible one of its pack. */
export interface Candidate {
  id: string;
  version: string;
  sha256: string;
  state: string;
  score_rules_version: string | null;
  report_key: string | null;
  pack_id: string;
  pack: string;
  scope: string;
  scope_id: string;
  visibility: "public" | "private";
}

export interface Pass {
  kind: PassKind;
  trigger: string;
  cursor: string | null;
  versions: number;
  findings: number;
  completed: boolean;
  started_at: string;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The pass for this trigger, begun if it was not; a trigger that has completed stays completed. */
export async function openPass(d1: D1, kind: PassKind, trigger: string, at: string): Promise<Pass> {
  await d1.query(`insert or ignore into rescan_passes (kind, trigger, started_at, updated_at) values (?, ?, ?, ?)`, [kind, trigger, at, at]);
  const row = (await d1.query(`select cursor, versions, findings, completed_at, started_at from rescan_passes where kind = ? and trigger = ?`, [kind, trigger])).rows[0]!;
  return { kind, trigger, cursor: (row.cursor as string | null) ?? null, versions: Number(row.versions), findings: Number(row.findings), completed: row.completed_at !== null, started_at: String(row.started_at) };
}

/**
 * Records where the pass got to, but only if nobody else moved it since `pass` was read: two fires
 * that overlap both do the page, and the one that loses the compare-and-set on the cursor adds
 * nothing. Returns whether this call advanced the pass.
 */
export async function advancePass(d1: D1, pass: Pass, step: { cursor: string | null; versions: number; findings: number; done: boolean }, at: string): Promise<boolean> {
  const moved = await d1.query(
    `update rescan_passes set cursor = ?, versions = versions + ?, findings = findings + ?, updated_at = ?, completed_at = ? where kind = ? and trigger = ? and completed_at is null and cursor is ?`,
    [step.done ? null : step.cursor, step.versions, step.findings, at, step.done ? at : null, pass.kind, pass.trigger, pass.cursor],
  );
  return moved.meta.changes > 0;
}

const WITH_ELIGIBLE = `v.state in ('active', 'deprecated') and v.published_at is not null`;

const CANDIDATE_COLUMNS = `v.id, v.version, v.sha256, v.state, v.score_rules_version, v.report_key, p.id as pack_id, s.name as scope, p.scope_id, p.name as pack_name, p.visibility`;

const toCandidate = (r: Record<string, unknown>): Candidate => ({
  id: String(r.id),
  version: String(r.version),
  sha256: String(r.sha256),
  state: String(r.state),
  score_rules_version: (r.score_rules_version as string | null) ?? null,
  report_key: (r.report_key as string | null) ?? null,
  pack_id: String(r.pack_id),
  pack: `@${String(r.scope)}/${String(r.pack_name)}`,
  scope: String(r.scope),
  scope_id: String(r.scope_id),
  visibility: r.visibility === "private" ? "private" : "public",
});

/** The newest eligible version of each pack among `packIds`, in the order the packs were asked for. */
async function newestOf(d1: D1, packIds: readonly string[]): Promise<Candidate[]> {
  if (packIds.length === 0) return [];
  const { rows } = await d1.query(
    `select ${CANDIDATE_COLUMNS} from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
      where v.pack_id in (${placeholders(packIds.length)}) and ${WITH_ELIGIBLE}`,
    [...packIds],
  );
  const newest = new Map<string, Candidate>();
  for (const row of rows) {
    const candidate = toCandidate(row);
    const held = newest.get(candidate.pack_id);
    if (!held || compareVersions(candidate.version, held.version) > 0) newest.set(candidate.pack_id, candidate);
  }
  return packIds.flatMap((id) => newest.get(id) ?? []);
}

/** Up to `limit` packs after `cursor`, in id order, each with its newest eligible version; `last` is where the next page starts. */
export async function packsAfter(d1: D1, cursor: string | null, limit: number): Promise<{ candidates: Candidate[]; last: string | null; exhausted: boolean }> {
  const { rows } = await d1.query(
    `select p.id from packs p join scopes s on s.id = p.scope_id
      where p.id > ? and ${publicScopeOnly("s")} and exists (select 1 from pack_versions v where v.pack_id = p.id and ${WITH_ELIGIBLE})
      order by p.id limit ?`,
    [cursor ?? "", limit],
  );
  const ids = rows.map((r) => String(r.id));
  return { candidates: await newestOf(d1, ids), last: ids.at(-1) ?? cursor, exhausted: ids.length < limit };
}

/** The thousand packs declared by the most public repositories in the latest completed adoption scan, from rank `offset`. */
export async function topDeclared(d1: D1, offset: number, limit: number, top: number): Promise<{ candidates: Candidate[]; exhausted: boolean; scanned: boolean }> {
  const scan = (await d1.query(`select id from adoption_scans where completed_at is not null order by completed_at desc, id desc limit 1`)).rows[0];
  if (!scan) return { candidates: [], exhausted: false, scanned: false };
  const take = Math.max(0, Math.min(limit, top - offset));
  const { rows } = await d1.query(
    `select pack from pack_declarations where scan_id = ? group by pack order by count(distinct repository) desc, pack limit ? offset ?`,
    [scan.id, take, offset],
  );
  const names = rows.map((r) => String(r.pack));
  if (names.length === 0) return { candidates: [], exhausted: true, scanned: true };
  const packs = await d1.query(
    `select p.id, '@' || s.name || '/' || p.name as name from packs p join scopes s on s.id = p.scope_id
      where p.visibility = 'public' and ${publicScopeOnly("s")} and '@' || s.name || '/' || p.name in (${placeholders(names.length)})`,
    names,
  );
  const idOf = new Map(packs.rows.map((r) => [String(r.name), String(r.id)]));
  const candidates = await newestOf(d1, names.flatMap((n) => idOf.get(n) ?? []));
  return { candidates, exhausted: names.length < take || offset + names.length >= top, scanned: true };
}

export async function candidateOf(d1: D1, versionId: string): Promise<Candidate | null> {
  const row = (
    await d1.query(
      `select ${CANDIDATE_COLUMNS} from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id where v.id = ?`,
      [versionId],
    )
  ).rows[0];
  return row ? toCandidate(row) : null;
}

/**
 * Versions that were promoted after the rules pass for `rules` began, under older rules: a run that
 * started before the bump keeps the rules it began with. Each pack's newest eligible version is
 * returned when it is behind, oldest promotion first; a stale version that a later promotion of its
 * pack has already outdated is not asked for again.
 */
export async function lateUnderOlderRules(d1: D1, rules: string, since: string, limit: number): Promise<Candidate[]> {
  const { rows } = await d1.query(
    `select distinct v.pack_id from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
      where ${WITH_ELIGIBLE} and ${publicScopeOnly("s")} and (v.score_rules_version is null or v.score_rules_version <> ?) and v.published_at >= ?
        and not exists (select 1 from pack_versions w where w.pack_id = v.pack_id and w.state in ('active', 'deprecated') and w.score_rules_version = ? and w.published_at >= v.published_at)
      order by v.pack_id limit ?`,
    [rules, since, rules, limit],
  );
  return newestOf(d1, rows.map((r) => String(r.pack_id)));
}
