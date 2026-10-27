import type { D1 } from "@packserver/ports";
import { loadRules } from "@packserver/rules";
import type { AdvisoryInput } from "./input.ts";
import { isoNow, type ReportPorts } from "./ports.ts";

type Statement = { sql: string; params: unknown[] };

export interface Advisory {
  id: string;
  pack: string;
  summary: string;
  severity: string;
  fixed_in: string | null;
  published_at: string;
  affected_versions: string[];
}

export type PublishResult =
  | { ok: true; advisory: Advisory }
  | { ok: false; reason: "not_found" | "not_security" | "exists" | "unknown_version"; message?: string };

/**
 * Registry security publishes an advisory for a security report, naming the affected versions. It is the only
 * public trace of the report: nothing of the report itself is copied beyond the summary registry security writes.
 */
export async function publishAdvisory(ports: ReportPorts, reportId: string, input: AdvisoryInput): Promise<PublishResult> {
  const { rows } = await ports.d1.query("select id, pack_id, kind, severity, fixed_in from reports where id = ?", [reportId]);
  const report = rows[0];
  if (!report) return { ok: false, reason: "not_found" };
  if (report.kind !== "security") return { ok: false, reason: "not_security", message: "Only a security report becomes an advisory." };
  const existing = await ports.d1.query("select id from advisories where report_id = ?", [reportId]);
  if (existing.rows.length > 0) return { ok: false, reason: "exists", message: "An advisory is already published for this report." };

  const versions = [...new Set(input.versions)];
  const fixedIn = input.fixed_in ?? (report.fixed_in === null ? null : String(report.fixed_in));
  const wanted = fixedIn === null ? versions : [...versions, fixedIn];
  const marks = wanted.map(() => "?").join(", ");
  const known = await ports.d1.query(`select version from pack_versions where pack_id = ? and version in (${marks})`, [report.pack_id, ...wanted]);
  const found = new Set(known.rows.map((r) => String(r.version)));
  const missing = wanted.find((v) => !found.has(v));
  if (missing !== undefined) return { ok: false, reason: "unknown_version", message: `This pack has no version ${missing}.` };

  const id = ports.rng.uuid();
  const caps = await capStatements(ports.d1, String(report.pack_id), versions);
  await ports.d1.batch([
    {
      sql: "insert into advisories (id, pack_id, report_id, summary, severity, fixed_in, published_at) values (?, ?, ?, ?, ?, ?, ?)",
      params: [id, report.pack_id, reportId, input.summary, input.severity ?? String(report.severity), fixedIn, isoNow(ports)],
    },
    ...versions.map((version) => ({ sql: "insert into advisory_versions (advisory_id, pack_id, version) values (?, ?, ?)", params: [id, report.pack_id, version] })),
    ...caps,
  ]);
  const published = (await advisoriesFor(ports.d1, String(report.pack_id))).find((a) => a.id === id);
  return { ok: true, advisory: published! };
}

/**
 * REQ-SCORE-004: a published advisory caps the score of each version it names. The stored total comes down to the cap and
 * the stored breakdown names the reason; a score already at or under the cap is left alone, and the breakdown's parts
 * stay wherever they were read from.
 */
async function capStatements(d1: D1, packId: string, versions: string[]): Promise<Statement[]> {
  if (versions.length === 0) return [];
  const marks = versions.map(() => "?").join(", ");
  const { rows } = await d1.query(`select version, score, score_rules_version, score_breakdown from pack_versions where pack_id = ? and version in (${marks})`, [packId, ...versions]);
  const statements: Statement[] = [];
  for (const row of rows) {
    if (row.score === null || row.score === undefined || row.score_rules_version === null || row.score_rules_version === undefined) continue;
    const { score } = loadRules(String(row.score_rules_version));
    const max = score.caps.published_advisory;
    if (Number(row.score) <= max) continue;
    let breakdown: Record<string, unknown> = {};
    try {
      const parsed: unknown = typeof row.score_breakdown === "string" ? JSON.parse(row.score_breakdown) : {};
      if (typeof parsed === "object" && parsed !== null) breakdown = parsed as Record<string, unknown>;
    } catch {
      // An unreadable breakdown is replaced by the cap alone.
    }
    statements.push({
      sql: "update pack_versions set score = ?, score_breakdown = ? where pack_id = ? and version = ?",
      params: [max, JSON.stringify({ ...breakdown, cap: { reason: score.cap_reasons.published_advisory, max } }), packId, String(row.version)],
    });
  }
  return statements;
}

/** Published advisories for a pack, or only those naming `version`. This is what `get_pack` returns per version. */
export async function advisoriesFor(d1: D1, packId: string, version?: string): Promise<Advisory[]> {
  const { rows } = await d1.query(
    `select a.id as id, s.name as scope, p.name as pack_name, a.summary as summary, a.severity as severity, a.fixed_in as fixed_in, a.published_at as published_at, v.version as version
     from advisories a join advisory_versions v on v.advisory_id = a.id join packs p on p.id = a.pack_id join scopes s on s.id = p.scope_id
     where a.pack_id = ? order by a.published_at, a.id, v.version`,
    [packId],
  );
  const byId = new Map<string, Advisory>();
  for (const r of rows) {
    const id = String(r.id);
    const entry = byId.get(id) ?? {
      id,
      pack: `@${String(r.scope)}/${String(r.pack_name)}`,
      summary: String(r.summary),
      severity: String(r.severity),
      fixed_in: r.fixed_in === null ? null : String(r.fixed_in),
      published_at: String(r.published_at),
      affected_versions: [],
    };
    entry.affected_versions.push(String(r.version));
    byId.set(id, entry);
  }
  const all = [...byId.values()];
  return version === undefined ? all : all.filter((a) => a.affected_versions.includes(version));
}

/**
 * Whether a published advisory names this version: the one input the score cap (REQ-SCORE-004) and the ranking
 * demotion (REQ-COMM-010) read. A report that is not yet an advisory never counts.
 */
export async function hasPublishedAdvisory(d1: D1, packId: string, version: string): Promise<boolean> {
  const { rows } = await d1.query("select 1 as found from advisory_versions where pack_id = ? and version = ? limit 1", [packId, version]);
  return rows.length > 0;
}
