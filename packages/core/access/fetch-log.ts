import { FETCH_LOG_RETENTION_DAYS } from "./keys.ts";
import type { Clock, D1, Rng } from "@packserver/ports";
import type { Caller } from "./callers.ts";

export interface FetchLogPorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

export interface FetchRecord {
  packId: string;
  versionId?: string;
  kind: "index" | "download";
  outcome: "served" | "denied";
  caller: Caller;
  /** A keyed hash of the caller; absent when the key is not configured. */
  callerHash: string | undefined;
  /** The GitHub account behind a signed-in caller; an OIDC caller's is read from its token. */
  accountId?: string | null;
}

const DAY_MS = 86_400_000;

/** The granted account and repository come from the verified credential, never from the request. */
function identityOf(caller: Caller): { account: string | null; repository: string | null } {
  return caller.kind === "oidc" ? { account: caller.ownerId, repository: caller.repository } : { account: null, repository: null };
}

/** Records one read and drops what is past retention, so the 90 days hold without a separate job. */
export async function recordFetch(ports: FetchLogPorts, record: FetchRecord): Promise<void> {
  const now = ports.clock.now();
  const { account, repository } = identityOf(record.caller);
  await ports.d1.batch([
    { sql: "delete from fetch_log where at < ?", params: [now - FETCH_LOG_RETENTION_DAYS * DAY_MS] },
    {
      sql: "insert into fetch_log (id, pack_id, version_id, kind, outcome, caller, caller_hash, account_id, repository, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [ports.rng.uuid(), record.packId, record.versionId ?? null, record.kind, record.outcome, record.caller.kind, record.callerHash ?? null, record.accountId ?? account, repository, now],
    },
  ]);
}

export interface FetchView {
  kind: "index" | "download";
  outcome: "served" | "denied";
  account_id: string | null;
  repository: string | null;
  at: number;
}

/** What the pack's owner sees: reads by account and repository, newest first. */
export async function listFetches(d1: D1, packId: string, limit = 100): Promise<FetchView[]> {
  const { rows } = await d1.query("select kind, outcome, account_id, repository, at from fetch_log where pack_id = ? order by at desc, id limit ?", [packId, limit]);
  return rows as unknown as FetchView[];
}
