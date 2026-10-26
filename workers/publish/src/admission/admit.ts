import { createAudit } from "@packserver/core/audit";
import { sha256Hex } from "@packserver/core/index";
import {
  NEW_PACKS_PER_ACCOUNT_PER_DAY, RUNS_PER_PUBLISHER_PER_DAY, SOFT_RATE_LIMIT_FAILED_RUNS, SYNTHETIC_VERSION_TTL_MS, VERSIONS_PER_PACK_PER_DAY, capMessage, checkIntegrity, dryRunCap,
  isSyntheticScope, isVerifiedPublisher, isYoungAccount, newPackCap, nextRunStart, nextUtcMidnight, utcDay, type QuotaKind,
} from "@packserver/core/publishing";
import { refusal } from "@packserver/http";
import type { PublishRuntime } from "../bindings";
import { quotaName } from "../quota";
import { runByCredential, type RunRow } from "../runs/store";
import { unavailable } from "../respond";
import type { CredentialRow } from "../upload/credentials";

export type RunKind = "publish" | "dry-run";

export interface AdmissionRequest {
  credential: CredentialRow;
  kind: RunKind;
  declaredSha256: string;
  proseScreen: boolean;
}

export type Admission = { ok: true; run: RunRow; created: boolean } | { ok: false; response: Response };

/** How long a start waits for the scope's publish lock before it asks the caller to try again. */
export const LOCK_WAIT_MS = 8_000;
const LOCK_POLL_MS = 25;
const LOCK_TTL_S = 20;

/** The flag that holds the registry-wide daily sandbox-minute budget; with none set, no budget is enforced. */
export const SANDBOX_BUDGET_FLAG = "sandbox_daily_minutes";

interface ScopeRow {
  id: string;
  name: string;
  state: "active" | "held";
  verified_domain: string | null;
  verified_github_org: string | null;
}

interface Cap {
  kind: QuotaKind;
  principal: string;
  cap: number;
  what: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const one = <T>(rows: Array<Record<string, unknown>>): T | undefined => rows[0] as T | undefined;

/**
 * Steps 1 and 2 of the pipeline: whether this publisher may start a run now, and whether the
 * staged bytes are the ones declared. Publishes go one at a time per scope behind the scope's
 * lock, which is what makes two concurrent publishes of one version a single version and a
 * single new-pack count. Nothing is decompressed here.
 */
export async function admit(runtime: PublishRuntime, request: AdmissionRequest): Promise<Admission> {
  const { d1 } = runtime.ports;
  const { credential } = request;

  const earlier = await runByCredential(d1, credential.id);
  if (earlier) {
    return earlier.declared_sha256 === request.declaredSha256
      ? { ok: true, run: earlier, created: false }
      : { ok: false, response: refusal("exists", { message: "this credential already started a run for different bytes" }) };
  }
  const wanted = request.kind === "publish" ? "draft" : "dry-run";
  if (credential.lifetime !== wanted) {
    return { ok: false, response: refusal("forbidden", { message: `this credential cannot start a ${request.kind}` }) };
  }
  if (request.kind === "dry-run" && credential.user_id === null) {
    return { ok: false, response: refusal("forbidden", { message: "a dry-run belongs to a signed-in publisher" }) };
  }
  if (credential.uploaded_at === null) {
    return { ok: false, response: new Response(JSON.stringify({ error: "missing", message: "the upload has not been confirmed" }), { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } }) };
  }

  if (request.kind === "dry-run") return admitUnderLock(runtime, request);

  const { durableObjects, rng } = runtime.ports;
  const holder = rng.uuid().replace(/-/g, "");
  const scopeName = credential.scope;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const lock = await durableObjects.call("ScopeCoordinator", scopeName, "acquireLock", [{ run_id: holder, ttl_s: LOCK_TTL_S }]);
    if (lock.acquired) break;
    if (Date.now() >= deadline) return { ok: false, response: unavailable("another publish for this scope is in progress", 2) };
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await admitUnderLock(runtime, request);
  } finally {
    await durableObjects.call("ScopeCoordinator", scopeName, "releaseLock", [{ run_id: holder }]).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "publish.lock_release_failed", detail: String(error) }));
    });
  }
}

/** Whether a version is a version already: published, retired, or carried by a publish run that has neither failed nor expired. */
export async function versionTaken(d1: PublishRuntime["ports"]["d1"], scope: { id: string; name: string }, packName: string, version: string, now: number): Promise<boolean> {
  const taken = await d1.query(
    `select 1 from pack_versions v join packs p on p.id = v.pack_id where p.scope_id = ? and p.name = ? and v.version = ?
     union all select 1 from retired_names where kind = 'version' and name = ?
     union all select 1 from validation_runs where scope_id = ? and pack_name = ? and version = ? and kind = 'publish'
       and not (status = 'finished' and verdict in ('fail', 'error'))
       and (expires_at is null or expires_at > ?)`,
    [scope.id, packName, version, `@${scope.name}/${packName}@${version}`, scope.id, packName, version, new Date(now).toISOString()],
  );
  return taken.rows.length > 0;
}

async function admitUnderLock(runtime: PublishRuntime, request: AdmissionRequest): Promise<Admission> {
  const { d1, clock, rng, r2, durableObjects, stats } = runtime.ports;
  const { credential, kind } = request;
  const now = clock.now();
  const nowIso = new Date(now).toISOString();
  const day = utcDay(now);
  const dayStartIso = `${day}T00:00:00.000Z`;

  const scope = one<ScopeRow>((await d1.query(`select id, name, state, verified_domain, verified_github_org from scopes where id = ?`, [credential.scope_id])).rows);
  if (!scope || scope.state === "held") {
    await auditRefusal(runtime, credential, kind, "scope-held", scope?.id);
    return { ok: false, response: refusal("forbidden", { message: "this scope cannot publish until an admin clears it" }) };
  }
  const synthetic = isSyntheticScope(scope.name);
  const principal = credential.user_id ? `user:${credential.user_id}` : `scope:${scope.id}`;
  const packName = credential.pack_name;
  const version = credential.version;

  let packExists = false;
  if (kind === "publish") {
    if (await versionTaken(d1, scope, packName, version, now)) {
      return { ok: false, response: refusal("exists", { message: `@${scope.name}/${packName}@${version} already exists` }) };
    }
    packExists = (await d1.query(`select 1 from packs where scope_id = ? and name = ?`, [scope.id, packName])).rows.length > 0;
  }

  const account = credential.user_id ? await accountOf(d1, credential.user_id, now) : null;
  let countsNewPack = false;
  if (kind === "publish" && !packExists) {
    const counted = await d1.query(
      `select 1 from validation_runs where scope_id = ? and pack_name = ? and kind = 'publish' and counted_new_pack = 1 and created_at >= ?`,
      [scope.id, packName, dayStartIso],
    );
    countsNewPack = counted.rows.length === 0;
  }

  const caps: Cap[] = [{ kind: "validation_runs", principal, cap: RUNS_PER_PUBLISHER_PER_DAY, what: "validation runs" }];
  if (kind === "dry-run") {
    caps.push({ kind: "dry_runs", principal, cap: dryRunCap(account ?? { ageMs: Infinity, hasPromotedPack: true }), what: "dry-runs" });
  } else {
    caps.push({ kind: "versions_per_pack", principal: `pack:${scope.id}/${packName}`, cap: VERSIONS_PER_PACK_PER_DAY, what: `new versions of @${scope.name}/${packName}` });
    if (countsNewPack) caps.push({ kind: "new_packs_per_scope", principal: `scope:${scope.id}`, cap: newPackCap(isVerifiedPublisher(scope)), what: `new packs in @${scope.name}` });
    if (countsNewPack && credential.user_id) caps.push({ kind: "new_packs_per_account", principal, cap: NEW_PACKS_PER_ACCOUNT_PER_DAY, what: "new packs by this account" });
  }
  const hit = await spendCaps(durableObjects, caps, day);
  if (hit) {
    stats.write({ name: "publish.quota_hit", blobs: [hit.kind, kind], doubles: [hit.cap] });
    stats.write({ name: "abuse.daily_cap_hit", blobs: [hit.kind], doubles: [hit.cap] });
    await auditRefusal(runtime, credential, kind, `quota:${hit.kind}`, scope.id);
    return { ok: false, response: refusal("quota", { message: capMessage(hit.what, hit.cap, now), retry_after_s: Math.max(1, Math.ceil((nextUtcMidnight(now) - now) / 1000)) }) };
  }

  const staging = r2.PACKS_STAGING;
  if (!staging) throw new Error("the PACKS_STAGING binding is missing");
  const head = await staging.head(credential.staging_key);
  if (!head) {
    return { ok: false, response: new Response(JSON.stringify({ error: "missing", message: "no object has been uploaded" }), { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } }) };
  }
  const integrity = await checkIntegrity({ size: head.size, read: () => staging.get(credential.staging_key) }, request.declaredSha256, sha256Hex);

  let startAfter = now;
  let queuedReason: RunRow["queued_reason"] = null;
  if (integrity.ok) {
    const failed = Number(one<{ n: number }>((await d1.query(`select count(*) as n from validation_runs where principal = ? and verdict = 'fail' and created_at >= ?`, [principal, dayStartIso])).rows)?.n ?? 0);
    if (failed >= SOFT_RATE_LIMIT_FAILED_RUNS) {
      const latest = one<{ latest: string | null }>((await d1.query(`select max(start_after) as latest from validation_runs where principal = ? and created_at >= ?`, [principal, dayStartIso])).rows)?.latest ?? null;
      startAfter = nextRunStart({ now, softLimited: true, latestGrantedStart: latest === null ? null : Date.parse(latest) });
      queuedReason = "soft-rate-limit";
    } else if (kind === "dry-run" && account && isYoungAccount(account) && (await sandboxBudgetSpent(d1, day))) {
      startAfter = nextUtcMidnight(now);
      queuedReason = "sandbox-budget";
    }
  }

  const runId = rng.uuid().replace(/-/g, "");
  const failure = integrity.ok ? null : integrity.reason;
  const expiresAt = synthetic && kind === "publish" ? new Date(now + SYNTHETIC_VERSION_TTL_MS).toISOString() : null;
  try {
    await d1.batch([
      {
        sql: `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, prose_screen, synthetic,
                status, verdict, reason, queued_reason, start_after, counted_new_pack, created_at, updated_at, finished_at, expires_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          runId, kind, credential.source, scope.id, packName, version, principal, credential.id, credential.staging_key, request.declaredSha256, head.size,
          request.proseScreen && !synthetic ? 1 : 0, synthetic ? 1 : 0,
          failure ? "finished" : "queued", failure ? "fail" : null, failure, queuedReason, new Date(startAfter).toISOString(), countsNewPack ? 1 : 0, nowIso, nowIso,
          failure ? nowIso : null, expiresAt,
        ],
      },
      { sql: `insert into validation_milestones (run_id, seq, step, outcome, detail, at) values (?, 1, 'admission', 'ok', ?, ?)`, params: [runId, queuedReason, nowIso] },
      {
        sql: `insert into validation_milestones (run_id, seq, step, outcome, detail, at) values (?, 2, 'integrity', ?, ?, ?)`,
        params: [runId, failure ? "fail" : "ok", failure, nowIso],
      },
    ]);
  } catch (error) {
    const raced = await runByCredential(d1, credential.id);
    if (raced) return { ok: true, run: raced, created: false };
    throw error;
  }
  stats.write({ name: failure ? "publish.failed" : "publish.received", blobs: [kind, credential.source, failure ?? "admitted"], doubles: [head.size] });
  const created = await runByCredential(d1, credential.id);
  if (!created) throw new Error("the run just inserted cannot be read back");
  return { ok: true, run: created, created: true };
}

/** The refusal is the record: a failed audit send is logged, and the publisher still gets the refusal. */
async function auditRefusal(runtime: PublishRuntime, credential: CredentialRow, kind: RunKind, reason: string, scopeId?: string): Promise<void> {
  const { queues, clock, rng, d1, telemetry } = runtime.ports;
  const queue = queues.AUDIT_QUEUE;
  if (!queue) throw new Error("the AUDIT_QUEUE binding is missing");
  try {
    const audit = createAudit({ clock, rng, queue, d1 }, { ipKey: (await telemetry.keys()).ipMaster ?? "" });
    await audit(
      credential.user_id ? { kind: "user", id: credential.user_id } : { kind: "system" },
      "publish.refused",
      `@${credential.scope}/${credential.pack_name}@${credential.version}`,
      { ...(credential.user_id ? { user_id: credential.user_id } : {}), ...(scopeId ? { scope_id: scopeId } : {}), detail: { reason, kind } },
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "publish.audit_failed", detail: String(error) }));
  }
}

/** Peeks every cap before consuming any, so a refusal burns nothing; each consume is then the exact check-and-increment. */
async function spendCaps(durableObjects: PublishRuntime["ports"]["durableObjects"], caps: readonly Cap[], day: string): Promise<Cap | null> {
  for (const cap of caps) {
    const { count } = await durableObjects.call("Quota", quotaName(cap.kind, cap.principal, day), "peek", [{ kind: cap.kind, principal: cap.principal, day }]);
    if (count >= cap.cap) return cap;
  }
  for (const cap of caps) {
    const spent = await durableObjects.call("Quota", quotaName(cap.kind, cap.principal, day), "consume", [{ kind: cap.kind, principal: cap.principal, day, cap: cap.cap }]);
    if (!spent.allowed) return cap;
  }
  return null;
}

async function accountOf(d1: PublishRuntime["ports"]["d1"], userId: string, now: number): Promise<{ ageMs: number; hasPromotedPack: boolean }> {
  const user = one<{ created_at: string }>((await d1.query(`select created_at from users where id = ?`, [userId])).rows);
  const promoted = await d1.query(
    `select 1 from scope_members m join packs p on p.scope_id = m.scope_id join pack_versions v on v.pack_id = p.id
     where m.user_id = ? and v.published_at is not null limit 1`,
    [userId],
  );
  return { ageMs: user ? now - Date.parse(user.created_at) : 0, hasPromotedPack: promoted.rows.length > 0 };
}

async function sandboxBudgetSpent(d1: PublishRuntime["ports"]["d1"], day: string): Promise<boolean> {
  const flag = one<{ value: string }>((await d1.query(`select value from feature_flags where key = ?`, [SANDBOX_BUDGET_FLAG])).rows);
  const budget = flag ? Number(JSON.parse(flag.value)) : NaN;
  if (!Number.isFinite(budget)) return false;
  const used = one<{ minutes: number }>((await d1.query(`select minutes from sandbox_usage where day = ?`, [day])).rows)?.minutes ?? 0;
  return used >= budget;
}
