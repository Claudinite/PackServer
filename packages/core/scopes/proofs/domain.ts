import type { ScopeRow } from "../access.ts";
import { newId } from "../personal.ts";
import {
  announceProofChange, dateOf, isoOf, LAPSE_AFTER_MS, notifyOwners, RECHECK_INTERVAL_MS, settingsUrl, TRANSFER_MEMORY_MS, type ProofPorts,
} from "./context.ts";
import { registrableLabel, judgeDomain } from "./public-suffix.ts";
import { raiseDispute } from "./disputes.ts";

export const CHALLENGE_LABEL = "_packserver-challenge";
export const AUTH_FILE_URL_PATH = "/.well-known/packserver-auth";

export interface Challenge {
  id: string;
  domain: string;
  token: string;
  state: "pending" | "proven" | "lapsed" | "moved";
  /** Publish this TXT record, or serve `wellKnown.body` at `wellKnown.url`. */
  txt: { name: string; value: string };
  wellKnown: { url: string; body: string };
}

interface ChallengeRow {
  id: string;
  scope_id: string;
  domain: string;
  token: string;
  state: Challenge["state"];
  proven_at: string | null;
  last_checked_at: string | null;
  failed_since: string | null;
  warned_at: string | null;
}

const SELECT = "id, scope_id, domain, token, state, proven_at, last_checked_at, failed_since, warned_at";

export const viewChallenge = (row: Pick<ChallengeRow, "id" | "domain" | "token" | "state">): Challenge => ({
  id: row.id,
  domain: row.domain,
  token: row.token,
  state: row.state,
  txt: { name: `${CHALLENGE_LABEL}.${row.domain}`, value: row.token },
  wellKnown: { url: `https://${row.domain}${AUTH_FILE_URL_PATH}`, body: row.token },
});

const isUnique = (error: unknown): boolean => /UNIQUE/i.test(String(error));
const newToken = (ports: Pick<ProofPorts, "rng">): string => `packserver-${newId(ports)}`;

export type StartResult =
  | { ok: true; challenge: Challenge }
  | { ok: false; reason: "format" | "public_suffix" | "has_domain"; message: string };

/**
 * Issues (or returns again) the token for proving `rawDomain`. A public suffix is refused before
 * any lookup; a scope holds one proven domain at a time.
 */
export async function startDomainProof(ports: ProofPorts, scope: ScopeRow, rawDomain: string): Promise<StartResult> {
  const judged = judgeDomain(rawDomain);
  if (!judged.ok) return judged;
  const { rows } = await ports.d1.query(`select ${SELECT} from domain_challenges where scope_id = ? and state in ('pending', 'proven')`, [scope.id]);
  const mine = rows as unknown as ChallengeRow[];
  const proven = mine.find((r) => r.state === "proven");
  if (proven && proven.domain !== judged.domain) {
    return { ok: false, reason: "has_domain", message: `${scope.name} already holds the proof of ${proven.domain}.` };
  }
  const existing = mine.find((r) => r.domain === judged.domain);
  if (existing) return { ok: true, challenge: viewChallenge(existing) };

  const row = { id: newId(ports), domain: judged.domain, token: newToken(ports), state: "pending" as const };
  try {
    await ports.d1.query("insert into domain_challenges (id, scope_id, domain, token, state, created_at) values (?, ?, ?, ?, 'pending', ?)", [
      row.id, scope.id, row.domain, row.token, isoOf(ports.clock.now()),
    ]);
  } catch (error) {
    if (!isUnique(error)) throw error;
    const again = await ports.d1.query(`select ${SELECT} from domain_challenges where scope_id = ? and domain = ? and state = 'pending'`, [scope.id, judged.domain]);
    return { ok: true, challenge: viewChallenge(again.rows[0] as unknown as ChallengeRow) };
  }
  return { ok: true, challenge: viewChallenge(row) };
}

export type Probe =
  | { found: "txt" | "well-known" }
  | { found: null; result: "mismatch" | "missing" | "unreachable"; detail?: string };

/**
 * Looks for the token at the TXT name and, failing that, in the one `.well-known` file. A record
 * that is there but holds another token is a `mismatch`; a resolver that could not answer is
 * `unreachable`, which is not the same as the record being absent.
 */
export async function probeDomain(ports: Pick<ProofPorts, "dns" | "wellKnown">, domain: string, token: string): Promise<Probe> {
  let dnsFailed = false;
  let other = false;
  try {
    const values = (await ports.dns.resolveTxt(`${CHALLENGE_LABEL}.${domain}`)).map((v) => v.trim());
    if (values.includes(token)) return { found: "txt" };
    other = values.some((v) => v !== "");
  } catch {
    dnsFailed = true;
  }
  const file = await ports.wellKnown.authFile(domain);
  if (file.status === "found") {
    if (file.body.trim() === token) return { found: "well-known" };
    other = true;
  }
  if (other) return { found: null, result: "mismatch" };
  if (file.status === "absent" && (file.reason === "redirected" || file.reason === "too_large")) return { found: null, result: "missing", detail: file.reason };
  if (dnsFailed && file.status === "absent" && file.reason === "unreachable") return { found: null, result: "unreachable" };
  return { found: null, result: "missing", ...(file.status === "absent" ? { detail: file.reason } : {}) };
}

export type CheckResult =
  | { status: "verified"; domain: string; method: "txt" | "well-known"; transferred: boolean; movedFrom: string | null }
  | { status: "mismatch" | "missing" | "unreachable"; domain: string; detail?: string }
  | { status: "unknown_challenge" | "ended" };

const yearAgo = (ports: Pick<ProofPorts, "clock">): string => isoOf(ports.clock.now() - TRANSFER_MEMORY_MS);

/**
 * "Check now": proves the scope holds the domain if the token is there. Whoever the record names
 * holds the proof; the scope that held it loses only the proof (REQ-SCOPE-007).
 */
export async function checkDomainProof(ports: ProofPorts, scope: ScopeRow, challengeId: string): Promise<CheckResult> {
  const found = await ports.d1.query(`select ${SELECT} from domain_challenges where id = ? and scope_id = ?`, [challengeId, scope.id]);
  const row = found.rows[0] as unknown as ChallengeRow | undefined;
  if (!row) return { status: "unknown_challenge" };
  if (row.state === "lapsed" || row.state === "moved") return { status: "ended" };

  const probe = await probeDomain(ports, row.domain, row.token);
  if (probe.found === null) return { status: probe.result, domain: row.domain, ...(probe.detail ? { detail: probe.detail } : {}) };

  const now = isoOf(ports.clock.now());
  if (row.state === "proven") {
    await ports.d1.query("update domain_challenges set last_checked_at = ?, failed_since = null, warned_at = null where id = ?", [now, row.id]);
    return { status: "verified", domain: row.domain, method: probe.found, transferred: false, movedFrom: null };
  }

  const holder = (
    await ports.d1.query("select c.id as id, c.scope_id as scope_id, s.name as name from domain_challenges c join scopes s on s.id = c.scope_id where c.domain = ? and c.state = 'proven' and c.scope_id <> ?", [row.domain, scope.id])
  ).rows[0] as { id: string; scope_id: string; name: string } | undefined;
  const recent = (
    await ports.d1.query("select 1 as hit from domain_challenges where domain = ? and scope_id <> ? and ended_at is not null and ended_at >= ? limit 1", [row.domain, scope.id, yearAgo(ports)])
  ).rows.length > 0;
  const transferred = holder !== undefined || recent;

  try {
    await ports.d1.batch([
      ...(holder
        ? [
            { sql: "update domain_challenges set state = 'moved', ended_at = ? where id = ?", params: [now, holder.id] },
            { sql: "update scopes set verified_domain = null where id = ? and verified_domain = ?", params: [holder.scope_id, row.domain] },
          ]
        : []),
      {
        sql: `update domain_challenges set state = 'proven', method = ?, proven_at = ?, last_checked_at = ?, failed_since = null, warned_at = null, transferred_at = ?
              where id = ? and state = 'pending'`,
        params: [probe.found, now, now, transferred ? now : null, row.id],
      },
      { sql: "update scopes set verified_domain = ? where id = ?", params: [row.domain, scope.id] },
    ]);
  } catch (error) {
    if (isUnique(error)) return { status: "ended" };
    throw error;
  }

  await announceProofChange(ports, scope.name, "domain_verified");
  if (holder) {
    await announceProofChange(ports, holder.name, "domain_moved");
    await notifyOwners(ports, holder.scope_id, "domain-proof-moved", { scope: holder.name, domain: row.domain, scopeUrl: settingsUrl(ports, holder.name) });
  }
  await raiseDispute(ports, scope, row.domain, registrableLabel(row.domain));
  return { status: "verified", domain: row.domain, method: probe.found, transferred, movedFrom: holder?.name ?? null };
}

export interface RecheckSummary {
  checked: number;
  kept: number;
  warned: number;
  lapsed: number;
  skipped: number;
}

/**
 * Re-checks each proven domain once its last check is 30 days old. The first failure starts the
 * clock and mails the owners the removal date; a failure 30 days after that removes the proof.
 * A resolver that cannot answer changes nothing and is tried again on the next run.
 */
export async function recheckDomains(ports: ProofPorts): Promise<RecheckSummary> {
  const nowMs = ports.clock.now();
  const now = isoOf(nowMs);
  const due = (
    await ports.d1.query(
      `select c.id, c.scope_id, c.domain, c.token, c.state, c.proven_at, c.last_checked_at, c.failed_since, c.warned_at, s.name as scope_name
       from domain_challenges c join scopes s on s.id = c.scope_id
       where c.state = 'proven' and coalesce(c.last_checked_at, c.proven_at) <= ? order by c.id`,
      [isoOf(nowMs - RECHECK_INTERVAL_MS)],
    )
  ).rows as unknown as Array<ChallengeRow & { scope_name: string }>;

  const summary: RecheckSummary = { checked: 0, kept: 0, warned: 0, lapsed: 0, skipped: 0 };
  for (const row of due) {
    const probe = await probeDomain(ports, row.domain, row.token);
    if (probe.found === null && probe.result === "unreachable") {
      summary.skipped++;
      continue;
    }
    summary.checked++;
    if (probe.found !== null) {
      await ports.d1.query("update domain_challenges set last_checked_at = ?, failed_since = null, warned_at = null where id = ?", [now, row.id]);
      summary.kept++;
      continue;
    }
    const failedSince = row.failed_since ?? now;
    const failedMs = Date.parse(failedSince);
    if (nowMs - failedMs >= LAPSE_AFTER_MS) {
      await ports.d1.batch([
        { sql: "update domain_challenges set state = 'lapsed', ended_at = ?, last_checked_at = ? where id = ? and state = 'proven'", params: [now, now, row.id] },
        { sql: "update scopes set verified_domain = null where id = ? and verified_domain = ?", params: [row.scope_id, row.domain] },
      ]);
      await announceProofChange(ports, row.scope_name, "domain_lapsed");
      summary.lapsed++;
      continue;
    }
    await ports.d1.query("update domain_challenges set last_checked_at = ?, failed_since = ?, warned_at = coalesce(warned_at, ?) where id = ?", [now, failedSince, now, row.id]);
    if (row.warned_at === null) {
      await notifyOwners(ports, row.scope_id, "domain-proof-warning", {
        scope: row.scope_name,
        domain: row.domain,
        failedChecks: 1,
        removalDate: dateOf(failedMs + LAPSE_AFTER_MS),
        scopeUrl: settingsUrl(ports, row.scope_name),
      });
      summary.warned++;
    }
  }
  return summary;
}

export interface DomainProofView {
  proven: { domain: string; method: "txt" | "well-known" | null; since: string | null; transferred_at: string | null } | null;
  pending: Challenge[];
}

export async function domainProofsOf(ports: Pick<ProofPorts, "d1">, scopeId: string): Promise<DomainProofView> {
  const { rows } = await ports.d1.query(
    "select id, domain, token, state, method, proven_at, transferred_at from domain_challenges where scope_id = ? and state in ('pending', 'proven') order by created_at, id",
    [scopeId],
  );
  const proven = rows.find((r) => r.state === "proven");
  return {
    proven: proven
      ? {
          domain: String(proven.domain),
          method: (proven.method as "txt" | "well-known" | null) ?? null,
          since: (proven.proven_at as string | null) ?? null,
          transferred_at: (proven.transferred_at as string | null) ?? null,
        }
      : null,
    pending: rows.filter((r) => r.state === "pending").map((r) => viewChallenge(r as unknown as ChallengeRow)),
  };
}
