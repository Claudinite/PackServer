import type { Clock, D1, Queue, R2 } from "@packserver/ports";
import { objectKey, type ObjectKind } from "../catalog/view.ts";
import { privateArchiveKey } from "../access/keys.ts";
import { contentsKey } from "../validation/promotion.ts";

export type VersionTransition = "quarantine" | "unquarantine" | "yank" | "revoke" | "deprecate" | "unyank";

/** Who asks: a publisher is held to what a moderation hold protects, an operator is not. */
export type TransitionActor = "publisher" | "operator";

export interface TransitionPorts {
  d1: D1;
  clock: Clock;
  reindex: Pick<Queue, "send">;
}

export type VersionOutcome =
  | { ok: true; scope: string; changed: boolean }
  | { ok: false; reason: "unknown_version" | "not_quarantined" | "removed" | "revoked" | "not_allowed"; message: string };

interface Found {
  id: string;
  packId: string;
  state: string;
  reason: string | null;
  scope: string;
}

async function findVersion(d1: D1, pack: string, version: string): Promise<Found | null> {
  const row = (
    await d1.query(
      `select v.id, v.pack_id, v.state, v.status_reason, s.name as scope from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
       where '@' || s.name || '/' || p.name = ? and v.version = ?`,
      [pack, version],
    )
  ).rows[0];
  return row ? { id: String(row.id), packId: String(row.pack_id), state: String(row.state), reason: row.status_reason === null ? null : String(row.status_reason), scope: String(row.scope) } : null;
}

const TARGET: Record<VersionTransition, "quarantined" | "active" | "yanked" | "revoked" | "deprecated"> = {
  quarantine: "quarantined",
  unquarantine: "active",
  yank: "yanked",
  revoke: "revoked",
  deprecate: "deprecated",
  unyank: "active",
};

/** The states a transition may start from; a version never leaves `revoked` or `removed` through this path. */
const FROM: Record<VersionTransition, readonly string[]> = {
  quarantine: ["active", "deprecated", "yanked", "quarantined"],
  unquarantine: ["quarantined"],
  yank: ["active", "deprecated", "quarantined", "yanked"],
  revoke: ["active", "deprecated", "yanked", "quarantined", "revoked"],
  deprecate: ["active", "deprecated"],
  unyank: ["yanked"],
};

/** A publisher cannot yank a held version out of its hold, which would make its bytes fetchable again. */
const PUBLISHER_FROM: Partial<Record<VersionTransition, readonly string[]>> = { yank: ["active", "deprecated", "yanked"] };

/** Moderation's yank carries this prefix (REQ-MOD-016); a publisher's un-yank leaves such a yank in place. */
export const MODERATION_PREFIX = "Removed by PackServer";

/** The statuses a person is told of (REQ-MOD-013). */
const ANNOUNCED = new Set<VersionTransition>(["yank", "deprecate"]);
const OPEN_REPORT = "status in ('open', 'acknowledged')";

export interface TransitionInput {
  pack: string;
  version: string;
  reason: string | null;
  security?: string | null;
  by?: TransitionActor;
}

/**
 * The one way a version's status changes: it writes the status, queues the notices the change owes
 * (stargazers who opted into the digest, authors of open reports on the version) in the same batch and
 * has the scope's index signed again. `revoke` is the one way a version becomes `revoked` (REQ-VAL-018):
 * nothing automatic writes that state, and this runs only for an admin's decision.
 */
export async function transitionVersion(ports: TransitionPorts, transition: VersionTransition, input: TransitionInput): Promise<VersionOutcome> {
  const found = await findVersion(ports.d1, input.pack, input.version);
  if (!found) return { ok: false, reason: "unknown_version", message: `${input.pack}@${input.version} is not a version.` };
  if (found.state === "removed") return { ok: false, reason: "removed", message: `${input.pack}@${input.version} was removed.` };
  if (found.state === "revoked" && transition !== "revoke") return { ok: false, reason: "revoked", message: `${input.pack}@${input.version} is revoked; a revocation is not undone here.` };
  const by = input.by ?? "operator";
  const allowed = by === "publisher" ? (PUBLISHER_FROM[transition] ?? FROM[transition]) : FROM[transition];
  if (!allowed.includes(found.state)) {
    const reason = transition === "unquarantine" ? "not_quarantined" : "not_allowed";
    return { ok: false, reason, message: `${input.pack}@${input.version} is ${found.state}; it cannot be ${transition}d from there.` };
  }
  if (transition === "unyank" && by === "publisher" && found.reason?.startsWith(MODERATION_PREFIX)) {
    return { ok: false, reason: "not_allowed", message: `${input.pack}@${input.version} was yanked by PackServer; only PackServer lifts that.` };
  }
  const to = TARGET[transition];
  const lifted = to === "active";
  const reason = lifted ? null : input.reason;
  if (found.state === to && (by === "operator" || lifted || found.reason === reason)) return { ok: true, scope: found.scope, changed: false };

  const at = new Date(ports.clock.now()).toISOString();
  const statements = [
    {
      sql: "update pack_versions set state = ?, status_reason = ?, status_security = ?, status_changed_at = ? where id = ? and state = ?",
      params: [to, reason, to === "revoked" ? (input.security ?? input.reason) : to === "yanked" ? (input.security ?? null) : null, at, found.id, found.state],
    },
  ];
  if (ANNOUNCED.has(transition)) {
    statements.push({
      sql: `insert into lifecycle_notices (id, user_id, pack_id, version, action, reason, audience, created_at)
            select lower(hex(randomblob(16))), w.user_id, ?1, ?2, ?3, ?4, w.audience, ?5
              from (
                select reporter_id as user_id, 'reporter' as audience from reports where pack_id = ?1 and version = ?2 and ${OPEN_REPORT}
                union
                select s.user_id, 'stargazer' from stars s join star_digest_optins o on o.user_id = s.user_id
                  where s.pack_id = ?1 and s.user_id not in (select reporter_id from reports where pack_id = ?1 and version = ?2 and ${OPEN_REPORT})
              ) w
             where exists (select 1 from pack_versions where id = ?6 and state = ?7 and status_changed_at = ?5)`,
      params: [found.packId, input.version, to === "yanked" ? "yanked" : "deprecated", reason, at, found.id, to],
    });
  }
  await ports.d1.batch(statements);
  await ports.reindex.send({ schema: 1, type: "scope.proof_changed", scope: found.scope, change: "version_status_changed" });
  return { ok: true, scope: found.scope, changed: true };
}

/** REQ-PUB-024: a public version can be hard-deleted within this long of being published, and only while nobody has fetched it. */
export const HARD_DELETE_WINDOW_MS = 72 * 3_600_000;
/** REQ-PUB-025: a deleted private pack can be restored for this long. */
export const SOFT_DELETE_WINDOW_MS = 7 * 86_400_000;

/** The states a publisher may hard-delete a version from; a held or revoked version is evidence, not the publisher's to erase. */
const DELETABLE_STATES = ["active", "deprecated", "yanked"];

export type Deletable = { ok: true } | { ok: false; reason: "private" | "state" | "window" | "fetched" | "not_published" };

export interface DeleteRow {
  id: string;
  version: string;
  state: string;
  publishedAt: string | null;
}

/** Why a public version can or cannot be deleted now; `fetched` is a count of recorded fetches, which only the caller can look up. */
export function deletable(row: DeleteRow, nowMs: number, fetches: number): Deletable {
  if (row.publishedAt === null) return { ok: false, reason: "not_published" };
  if (!DELETABLE_STATES.includes(row.state)) return { ok: false, reason: "state" };
  if (nowMs - Date.parse(row.publishedAt) >= HARD_DELETE_WINDOW_MS) return { ok: false, reason: "window" };
  if (fetches > 0) return { ok: false, reason: "fetched" };
  return { ok: true };
}

const REASON_TEXT: Record<Exclude<Deletable, { ok: true }>["reason"], string> = {
  private: "A private pack's versions go with the pack.",
  state: "A held or revoked version cannot be deleted.",
  window: "A version can be deleted only within 72 hours of publishing.",
  fetched: "A version that has been fetched cannot be deleted.",
  not_published: "The version is not published.",
};

export interface PackToDelete {
  id: string;
  scope: string;
  scopeId: string;
  name: string;
  visibility: "public" | "private";
  removedAt: string | null;
}

export async function packVersionsForDelete(d1: D1, packId: string): Promise<Array<DeleteRow & { fetches: number }>> {
  const { rows } = await d1.query(
    `select v.id, v.version, v.state, v.published_at,
            (select count(*) from fetch_days f where f.pack_id = v.pack_id and f.version = v.version) as fetches
       from pack_versions v where v.pack_id = ? order by v.version`,
    [packId],
  );
  return rows.map((r) => ({ id: String(r.id), version: String(r.version), state: String(r.state), publishedAt: r.published_at === null ? null : String(r.published_at), fetches: Number(r.fetches) }));
}

/** What the delete affordance shows for each version of a public pack. */
export async function deleteOffers(d1: D1, clock: Clock, packId: string): Promise<Array<{ version: string; deletable: boolean; why?: string }>> {
  const now = clock.now();
  return (await packVersionsForDelete(d1, packId))
    .filter((v) => v.state !== "removed" && v.state !== "pending" && v.state !== "approved")
    .map((v) => {
      const verdict = deletable(v, now, v.fetches);
      return verdict.ok ? { version: v.version, deletable: true } : { version: v.version, deletable: false, why: REASON_TEXT[verdict.reason] };
    });
}

export type DeleteOutcome = { ok: true; scope: string } | { ok: false; reason: "unknown_version" | "refused"; message: string };

const retire = (kind: "pack" | "version", name: string, at: string) => ({
  sql: "insert or ignore into retired_names (kind, name, retired_at) values (?, ?, ?)",
  params: [kind, name, at],
});

/** REQ-PUB-024 (D51): the version becomes `removed`, its number is retired, and the reindex removes its bytes and its hash. */
export async function deleteVersion(ports: TransitionPorts, input: { pack: string; version: string }): Promise<DeleteOutcome> {
  const found = await findVersion(ports.d1, input.pack, input.version);
  if (!found) return { ok: false, reason: "unknown_version", message: `${input.pack}@${input.version} is not a version.` };
  const vis = (await ports.d1.query("select visibility from packs where id = ?", [found.packId])).rows[0]?.visibility;
  if (vis !== "public") return { ok: false, reason: "refused", message: REASON_TEXT.private };
  const row = (await packVersionsForDelete(ports.d1, found.packId)).find((v) => v.id === found.id)!;
  const verdict = deletable(row, ports.clock.now(), row.fetches);
  if (!verdict.ok) return { ok: false, reason: "refused", message: REASON_TEXT[verdict.reason] };
  const at = new Date(ports.clock.now()).toISOString();
  await ports.d1.batch([
    { sql: "update pack_versions set state = 'removed', status_reason = null, status_security = null, status_changed_at = ?, objects_purged_at = null where id = ? and state = ?", params: [at, found.id, found.state] },
    retire("version", `${input.pack}@${input.version}`, at),
  ]);
  await ports.reindex.send({ schema: 1, type: "scope.proof_changed", scope: found.scope, change: "version_removed" });
  return { ok: true, scope: found.scope };
}

/**
 * An owner deletes a pack. A public pack needs every version deletable by the rule above and is gone for good, its name
 * retired; a private pack can be deleted whatever its age or fetches and is restorable for 7 days.
 */
export async function deletePack(ports: TransitionPorts, pack: PackToDelete): Promise<DeleteOutcome> {
  if (pack.removedAt !== null) return { ok: false, reason: "refused", message: "The pack was deleted already." };
  const versions = await packVersionsForDelete(ports.d1, pack.id);
  const at = new Date(ports.clock.now()).toISOString();
  const full = `@${pack.scope}/${pack.name}`;
  if (pack.visibility === "public") {
    const live = versions.filter((v) => v.state !== "removed");
    if (live.some((v) => v.state === "pending" || v.state === "approved")) {
      return { ok: false, reason: "refused", message: "A version is still being published." };
    }
    for (const v of live) {
      const verdict = deletable(v, ports.clock.now(), v.fetches);
      if (!verdict.ok) return { ok: false, reason: "refused", message: `${v.version}: ${REASON_TEXT[verdict.reason]}` };
    }
    await ports.d1.batch([
      { sql: "update pack_versions set state = 'removed', status_reason = null, status_security = null, status_changed_at = ?, objects_purged_at = null where pack_id = ? and state not in ('removed', 'pending', 'approved')", params: [at, pack.id] },
      { sql: "update packs set removed_at = ? where id = ? and removed_at is null", params: [at, pack.id] },
      retire("pack", full, at),
      ...versions.map((v) => retire("version", `${full}@${v.version}`, at)),
    ]);
  } else {
    await ports.d1.batch([
      { sql: "update pack_versions set state_before_removal = state, state = 'removed', status_changed_at = ?, objects_purged_at = null where pack_id = ? and state not in ('removed', 'pending', 'approved')", params: [at, pack.id] },
      { sql: "update packs set removed_at = ? where id = ? and removed_at is null", params: [at, pack.id] },
    ]);
  }
  await ports.reindex.send({ schema: 1, type: "scope.proof_changed", scope: pack.scope, change: "pack_removed" });
  return { ok: true, scope: pack.scope };
}

export type RestoreOutcome = { ok: true; scope: string } | { ok: false; reason: "not_deleted" | "gone"; message: string };

/** REQ-PUB-025: within 7 days of the delete the private pack and its versions come back as they were. */
export async function restorePack(ports: TransitionPorts, pack: PackToDelete): Promise<RestoreOutcome> {
  if (pack.visibility !== "private" || pack.removedAt === null) return { ok: false, reason: "not_deleted", message: "The pack is not deleted." };
  if (ports.clock.now() - Date.parse(pack.removedAt) >= SOFT_DELETE_WINDOW_MS) return { ok: false, reason: "gone", message: "The 7 days to restore this pack have passed." };
  const at = new Date(ports.clock.now()).toISOString();
  await ports.d1.batch([
    { sql: "update pack_versions set state = state_before_removal, state_before_removal = null, status_changed_at = ? where pack_id = ? and state = 'removed' and state_before_removal is not null", params: [at, pack.id] },
    { sql: "update packs set removed_at = null where id = ?", params: [pack.id] },
  ]);
  await ports.reindex.send({ schema: 1, type: "scope.proof_changed", scope: pack.scope, change: "pack_restored" });
  return { ok: true, scope: pack.scope };
}

/** Whether a private pack deleted at `removedAt` can no longer be restored. */
export const softDeleteExpired = (removedAt: string, nowMs: number): boolean => nowMs - Date.parse(removedAt) >= SOFT_DELETE_WINDOW_MS;

export interface ReconcilePorts {
  d1: D1;
  clock: Clock;
  publicBucket: R2;
  privateBucket: R2;
  /** The origin the CDN answers on, so a purge names the URLs that were cached. */
  cdnOrigin: string;
  /** Purges the URLs from the CDN; false means it could not, and the purge is owed again. */
  purge(urls: string[]): Promise<boolean>;
}

const PER_VERSION_KINDS: Array<Exclude<ObjectKind, "versions">> = ["archive", "sha256", "attestation", "meta"];

export const publicKeysOf = (pack: string, version: string): string[] => [...PER_VERSION_KINDS.map((k) => objectKey(pack, k, version)), contentsKey(pack, version)];

/**
 * Removes the stored bytes of removed versions in `scope` and purges the CDN's copies, then marks the work done. A version
 * of a deleted private pack keeps its bytes until the 7 days to restore have passed. A purge that cannot be made leaves the
 * version owed, so the next reindex tries again; the signed index no longer lists a hash for the version either way.
 */
export async function reconcileRemoved(ports: ReconcilePorts, scope: string): Promise<{ deleted: number; purgePending: number }> {
  const nowMs = ports.clock.now();
  const { rows } = await ports.d1.query(
    `select v.id, v.version, p.id as pack_id, p.name, p.visibility, p.removed_at
       from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
      where s.name = ? and v.state = 'removed' and v.objects_purged_at is null`,
    [scope],
  );
  const at = new Date(nowMs).toISOString();
  let deleted = 0;
  let purgePending = 0;
  const expiredPacks = new Set<string>();
  for (const row of rows) {
    const pack = `@${scope}/${row.name}`;
    const version = String(row.version);
    if (row.visibility === "private") {
      if (row.removed_at === null || !softDeleteExpired(String(row.removed_at), nowMs)) continue;
      await ports.privateBucket.delete(privateArchiveKey(String(row.id)));
      for (const kind of ["attestation", "meta"] as const) await ports.privateBucket.delete(objectKey(pack, kind, version));
      expiredPacks.add(`${row.pack_id}|${pack}`);
      await ports.d1.query("update pack_versions set objects_purged_at = ? where id = ?", [at, row.id]);
      deleted += 1;
      continue;
    }
    for (const key of new Set([...publicKeysOf(pack, version), ...(await ports.publicBucket.list(`${pack}/${version}/`))])) await ports.publicBucket.delete(key);
    if (await ports.purge(publicKeysOf(pack, version).map((key) => `${ports.cdnOrigin}/${key}`))) {
      await ports.d1.query("update pack_versions set objects_purged_at = ? where id = ?", [at, row.id]);
    } else {
      purgePending += 1;
    }
    deleted += 1;
  }
  for (const entry of expiredPacks) {
    await ports.d1.query("insert or ignore into retired_names (kind, name, retired_at) values ('pack', ?, ?)", [entry.split("|")[1], at]);
  }
  return { deleted, purgePending };
}

const PURGE_BATCH = 30;

/**
 * The Cloudflare API purge for a zone: `files` in batches of 30, the most the API takes on every plan. Without a zone and a
 * token it purges nothing and says so.
 */
export function cdnPurger(config: { zoneId: string | undefined; token: () => Promise<string>; fetch: typeof fetch }): ReconcilePorts["purge"] {
  return async (urls) => {
    if (!config.zoneId) return false;
    const token = await config.token();
    for (let i = 0; i < urls.length; i += PURGE_BATCH) {
      const res = await config.fetch(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ files: urls.slice(i, i + PURGE_BATCH) }),
      });
      if (!res.ok) return false;
    }
    return true;
  };
}
