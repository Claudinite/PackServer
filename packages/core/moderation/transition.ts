import type { Clock, D1, Queue } from "@packserver/ports";

export type VersionTransition = "quarantine" | "unquarantine" | "yank" | "revoke";

export type VersionOutcome =
  | { ok: true; scope: string; changed: boolean }
  | { ok: false; reason: "unknown_version" | "not_quarantined" | "removed" | "revoked"; message: string };

interface Found {
  id: string;
  state: string;
  scope: string;
}

async function findVersion(d1: D1, pack: string, version: string): Promise<Found | null> {
  const row = (
    await d1.query(
      `select v.id, v.state, s.name as scope from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
       where '@' || s.name || '/' || p.name = ? and v.version = ?`,
      [pack, version],
    )
  ).rows[0];
  return row ? { id: String(row.id), state: String(row.state), scope: String(row.scope) } : null;
}

const TARGET: Record<VersionTransition, "quarantined" | "active" | "yanked" | "revoked"> = { quarantine: "quarantined", unquarantine: "active", yank: "yanked", revoke: "revoked" };

/** The states a transition may start from; a version never leaves `revoked` or `removed` through this path. */
const FROM: Record<VersionTransition, readonly string[]> = {
  quarantine: ["active", "deprecated", "yanked", "quarantined"],
  unquarantine: ["quarantined"],
  yank: ["active", "deprecated", "quarantined", "yanked"],
  revoke: ["active", "deprecated", "yanked", "quarantined", "revoked"],
};

/**
 * Moves a version to the status the transition names and has its scope's index signed again. `revoke` is the one way a
 * version becomes `revoked` (REQ-VAL-018): nothing automatic writes that state, and this runs only for an admin's decision.
 */
export async function transitionVersion(
  ports: { d1: D1; clock: Clock; reindex: Queue },
  transition: VersionTransition,
  input: { pack: string; version: string; reason: string | null; security?: string | null },
): Promise<VersionOutcome> {
  const found = await findVersion(ports.d1, input.pack, input.version);
  if (!found) return { ok: false, reason: "unknown_version", message: `${input.pack}@${input.version} is not a version.` };
  if (found.state === "removed") return { ok: false, reason: "removed", message: `${input.pack}@${input.version} was removed.` };
  if (found.state === "revoked" && transition !== "revoke") return { ok: false, reason: "revoked", message: `${input.pack}@${input.version} is revoked; a revocation is not undone here.` };
  if (!FROM[transition].includes(found.state)) {
    return { ok: false, reason: "not_quarantined", message: `${input.pack}@${input.version} is ${found.state}, not quarantined.` };
  }
  const to = TARGET[transition];
  if (found.state === to) return { ok: true, scope: found.scope, changed: false };
  const at = new Date(ports.clock.now()).toISOString();
  const lifted = to === "active";
  await ports.d1.query(
    "update pack_versions set state = ?, status_reason = ?, status_security = ?, status_changed_at = ? where id = ? and state = ?",
    [to, lifted ? null : input.reason, to === "revoked" ? (input.security ?? input.reason) : null, at, found.id, found.state],
  );
  // The reindex consumer re-signs the scope whatever `change` says.
  await ports.reindex.send({ schema: 1, type: "scope.proof_changed", scope: found.scope, change: "version_status_changed" });
  return { ok: true, scope: found.scope, changed: true };
}

/** Puts a version a moderation action took out of reach back to `active`; a version since moved on (revoked, removed) stays as it is. */
export async function restoreVersion(
  ports: { d1: D1; clock: Clock; reindex: Queue },
  pack: string,
  version: string,
): Promise<boolean> {
  const found = await findVersion(ports.d1, pack, version);
  if (!found || (found.state !== "quarantined" && found.state !== "yanked")) return false;
  await ports.d1.query("update pack_versions set state = 'active', status_reason = null, status_security = null, status_changed_at = ? where id = ?", [new Date(ports.clock.now()).toISOString(), found.id]);
  await ports.reindex.send({ schema: 1, type: "scope.proof_changed", scope: found.scope, change: "version_status_changed" });
  return true;
}
