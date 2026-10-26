import type { Clock, D1 } from "@packserver/ports";

export interface MismatchDeps {
  d1: D1;
  clock: Clock;
  id: () => string;
}

export interface MismatchReport {
  /** `@scope/name`. */
  pack: string;
  version: string;
  kind: "hash" | "signature";
  expected: string;
  observed: string;
}

export interface MismatchOutcome {
  /** Whether the report was kept; an unknown pack or version, a private pack the reporter's credential does not cover and a report that is no mismatch are not. */
  recorded: boolean;
  /** Distinct authenticated principals whose reports named the registry's own hash. */
  principals: number;
  /** This call moved the version to `quarantined` (a private pack only). */
  quarantined: boolean;
  /** This call put a public pack's version up for a person's review. */
  reviewOpened: boolean;
}

/** The credential behind a report: who it belongs to, and whether it covers the pack the report names. */
export interface Reporter {
  id: string | null;
  covers: boolean;
}

/** Two principals must agree before client reports act on a version. */
export const REPORTING_PRINCIPALS = 2;

/** A version in any of these states can be held; a withdrawn one is already out of reach. */
const HOLDABLE = ["active", "deprecated", "yanked"] as const;
const NOT_RECORDED: MismatchOutcome = { recorded: false, principals: 0, quarantined: false, reviewOpened: false };

interface VersionRow {
  packId: string;
  versionId: string;
  sha256: string;
  visibility: "public" | "private";
}

async function findVersion(d1: D1, pack: string, version: string): Promise<VersionRow | undefined> {
  const { rows } = await d1.query(
    `select p.id as pack_id, pv.id as version_id, pv.sha256 as sha256, p.visibility as visibility from pack_versions pv join packs p on p.id = pv.pack_id join scopes s on s.id = p.scope_id
      where '@' || s.name || '/' || p.name = ? and pv.version = ? and s.kind <> 'synthetic'`,
    [pack, version],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { packId: String(row.pack_id), versionId: String(row.version_id), sha256: String(row.sha256), visibility: row.visibility === "private" ? "private" : "public" };
}

async function openCase(deps: MismatchDeps, found: VersionRow, version: string, trigger: "reports" | "server" | "review"): Promise<boolean> {
  const at = new Date(deps.clock.now()).toISOString();
  const { meta } = await deps.d1.query(
    "insert or ignore into hash_mismatch_cases (pack_id, version, trigger, opened_at, paged_at) values (?, ?, ?, ?, ?)",
    [found.packId, version, trigger, at, at],
  );
  return meta.changes > 0;
}

async function quarantine(deps: MismatchDeps, found: VersionRow, version: string, trigger: "reports" | "server"): Promise<boolean> {
  const moved = await deps.d1.query(
    `update pack_versions set state = 'quarantined' where id = ? and state in (${HOLDABLE.map(() => "?").join(", ")})`,
    [found.versionId, ...HOLDABLE],
  );
  if (moved.meta.changes === 0) return false;
  // A review already open for this version becomes the hold.
  await deps.d1.query("delete from hash_mismatch_cases where pack_id = ? and version = ? and trigger = 'review'", [found.packId, version]);
  await openCase(deps, found, version, trigger);
  return true;
}

/**
 * Keeps a client's mismatch report. A private pack counts only reporters whose credential covers
 * it, and two of them hold the version. A public pack is open to anyone with an account, so its
 * reports never hold a version: two distinct authenticated principals put it up for a person's
 * review. Reports expecting some other hash, repeats by one principal and anonymous reports are
 * listed and count for nothing.
 */
export async function reportMismatch(deps: MismatchDeps, report: MismatchReport, reporter: Reporter): Promise<MismatchOutcome> {
  if (report.expected === report.observed) return NOT_RECORDED;
  const found = await findVersion(deps.d1, report.pack, report.version);
  if (!found) return NOT_RECORDED;
  const counts = reporter.id !== null && (found.visibility === "public" || reporter.covers);
  if (found.visibility === "private" && !counts) return NOT_RECORDED;
  await deps.d1.query(
    "insert into hash_mismatch_reports (id, pack_id, version, kind, reporter_id, expected, observed, reported_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    [deps.id(), found.packId, report.version, report.kind, reporter.id, report.expected, report.observed, new Date(deps.clock.now()).toISOString()],
  );
  const { rows } = await deps.d1.query(
    "select count(distinct reporter_id) as n from hash_mismatch_reports where pack_id = ? and version = ? and reporter_id is not null and expected = ?",
    [found.packId, report.version, found.sha256],
  );
  const principals = Number(rows[0]?.n ?? 0);
  const agreed = principals >= REPORTING_PRINCIPALS;
  const quarantined = agreed && found.visibility === "private" && (await quarantine(deps, found, report.version, "reports"));
  const reviewOpened = agreed && found.visibility === "public" && (await openCase(deps, found, report.version, "review"));
  return { recorded: true, principals, quarantined, reviewOpened };
}

/** A mismatch the registry saw itself holds the version at once, whatever clients have said. */
export async function observeServerMismatch(deps: MismatchDeps, observation: { pack: string; version: string }): Promise<{ quarantined: boolean }> {
  const found = await findVersion(deps.d1, observation.pack, observation.version);
  return { quarantined: found !== undefined && (await quarantine(deps, found, observation.version, "server")) };
}

export interface MismatchListing {
  version: string;
  reports: number;
  principals: number;
  anonymous: number;
  held: "reports" | "server" | "review" | null;
}

/** The trust dashboard's rows for one pack: what was reported, without who reported it. */
export async function mismatchesOf(d1: D1, pack: string): Promise<MismatchListing[]> {
  const { rows } = await d1.query(
    `select r.version as version, count(*) as reports, count(distinct r.reporter_id) as principals,
            sum(case when r.reporter_id is null then 1 else 0 end) as anonymous,
            (select c.trigger from hash_mismatch_cases c where c.pack_id = r.pack_id and c.version = r.version) as held
       from hash_mismatch_reports r join packs p on p.id = r.pack_id join scopes s on s.id = p.scope_id
      where '@' || s.name || '/' || p.name = ? group by r.pack_id, r.version order by r.version`,
    [pack],
  );
  return rows.map((r) => ({
    version: String(r.version),
    reports: Number(r.reports),
    principals: Number(r.principals),
    anonymous: Number(r.anonymous),
    held: r.held === "reports" || r.held === "server" || r.held === "review" ? r.held : null,
  }));
}
