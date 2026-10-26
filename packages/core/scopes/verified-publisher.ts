import type { D1 } from "@packserver/ports";
import type { ScopeRow } from "./access.ts";
import { iso, newId } from "./personal.ts";
import { announceProofChange, isoOf, notifyOwners, RENEWAL_WAIT_MS, settingsUrl, type ProofPorts } from "./proofs/context.ts";

export type MfaPolicy = "off" | "mfa" | "passkeys";

/** The scope-wide requirement for everyone acting for the scope (REQ-ACC-018); the setting is the accounts area's. */
export async function scopeMfaPolicy(d1: D1, scopeId: string): Promise<MfaPolicy> {
  const { rows } = await d1.query("select mfa from scope_policies where scope_id = ?", [scopeId]);
  const value = rows[0]?.mfa;
  return value === "mfa" || value === "passkeys" ? value : "off";
}

export type ApplicationState = "none" | "pending" | "approved" | "rejected" | "revoked";

export interface ApplicationView {
  id: string | null;
  state: ApplicationState;
  applied_at: string | null;
  decided_at: string | null;
  /** The admin's reason, shown to the owners of a rejected application. */
  denial_reason: string | null;
  /** A rejected application may be renewed from this instant. */
  renewable_at: string | null;
  basis: "domain" | "github" | null;
}

/** The newest application of the scope, or the "none" view. */
export async function applicationOf(d1: D1, scopeId: string): Promise<ApplicationView> {
  const { rows } = await d1.query(
    "select id, state, applied_at, decided_at, denial_reason, renewable_at, basis from vp_applications where scope_id = ? order by applied_at desc, id desc limit 1",
    [scopeId],
  );
  const r = rows[0];
  if (!r) return { id: null, state: "none", applied_at: null, decided_at: null, denial_reason: null, renewable_at: null, basis: null };
  return {
    id: String(r.id),
    state: r.state as ApplicationState,
    applied_at: String(r.applied_at),
    decided_at: (r.decided_at as string | null) ?? null,
    denial_reason: (r.denial_reason as string | null) ?? null,
    renewable_at: (r.renewable_at as string | null) ?? null,
    basis: (r.basis as "domain" | "github" | null) ?? null,
  };
}

/** What a Verified Publisher still lacks: a live proof, and MFA required scope-wide (REQ-SCOPE-010). */
async function missingConditions(d1: D1, scopeId: string, proofs: { verified_domain: string | null; verified_github_org: string | null }): Promise<Array<"proof" | "mfa">> {
  const missing: Array<"proof" | "mfa"> = [];
  if (!proofs.verified_domain && !proofs.verified_github_org) missing.push("proof");
  if ((await scopeMfaPolicy(d1, scopeId)) === "off") missing.push("mfa");
  return missing;
}

const needs = (missing: Array<"proof" | "mfa">): string =>
  missing.map((m) => (m === "proof" ? "prove a domain or a GitHub organisation" : "require MFA scope-wide")).join(" and ");

export type ApplyResult =
  | { ok: true; application: ApplicationView }
  | { ok: false; reason: "not_org" | "missing_conditions" | "pending" | "verified" | "renew_later"; message: string; missing?: Array<"proof" | "mfa">; renewable_at?: string };

/**
 * An owner applies once the scope has a domain or GitHub proof and requires MFA scope-wide.
 * The application waits for an admin; nothing here asks for payment (REQ-PAY-018).
 */
export async function applyForVerified(ports: ProofPorts, scope: ScopeRow, userId: string): Promise<ApplyResult> {
  if (scope.kind !== "org") return { ok: false, reason: "not_org", message: "Only an organisation can be a Verified Publisher." };
  const current = await applicationOf(ports.d1, scope.id);
  if (current.state === "approved") return { ok: false, reason: "verified", message: `${scope.name} is already a Verified Publisher.` };
  if (current.state === "pending") return { ok: false, reason: "pending", message: "The application is pending review." };
  if (current.state === "rejected" && current.renewable_at && Date.parse(current.renewable_at) > ports.clock.now()) {
    return { ok: false, reason: "renew_later", renewable_at: current.renewable_at, message: `The application was denied; it can be renewed from ${current.renewable_at.slice(0, 10)}.` };
  }

  const missing = await missingConditions(ports.d1, scope.id, scope);
  if (missing.length > 0) return { ok: false, reason: "missing_conditions", missing, message: `To apply, first ${needs(missing)}.` };

  const id = newId(ports);
  try {
    await ports.d1.query("insert into vp_applications (id, scope_id, state, applied_by, applied_at, basis) values (?, ?, 'pending', ?, ?, ?)", [
      id, scope.id, userId, iso(ports), scope.verified_domain ? "domain" : "github",
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) return { ok: false, reason: "pending", message: "The application is pending review." };
    throw error;
  }
  return { ok: true, application: await applicationOf(ports.d1, scope.id) };
}

export type DecisionResult =
  | { ok: true; scope: string }
  | { ok: false; reason: "unknown" | "not_pending" | "reason_required" | "missing_conditions"; message: string };

type Decision = { kind: "approve" } | { kind: "deny"; reason: string };

/** The review's outcome on a pending application; who may make it is the admin area's to enforce. */
export async function decideApplication(ports: ProofPorts, applicationId: string, adminUserId: string, decision: Decision): Promise<DecisionResult> {
  if (decision.kind === "deny" && decision.reason.trim() === "") return { ok: false, reason: "reason_required", message: "A denial needs a reason." };
  const found = (
    await ports.d1.query("select a.scope_id, a.state, s.name from vp_applications a join scopes s on s.id = a.scope_id where a.id = ?", [applicationId])
  ).rows[0];
  if (!found) return { ok: false, reason: "unknown", message: "No such application." };
  const scopeId = String(found.scope_id);
  const name = String(found.name);
  if (decision.kind === "approve") {
    const proofs = (await ports.d1.query("select verified_domain, verified_github_org from scopes where id = ?", [scopeId])).rows[0];
    const missing = await missingConditions(ports.d1, scopeId, {
      verified_domain: (proofs?.verified_domain as string | null | undefined) ?? null,
      verified_github_org: (proofs?.verified_github_org as string | null | undefined) ?? null,
    });
    if (missing.length > 0) return { ok: false, reason: "missing_conditions", message: `${name} no longer meets the conditions: it must ${needs(missing)}.` };
  }
  const nowMs = ports.clock.now();
  const changed = await ports.d1.query(
    `update vp_applications set state = ?, decided_at = ?, decided_by = ?, denial_reason = ?, renewable_at = ? where id = ? and state = 'pending'`,
    decision.kind === "approve"
      ? ["approved", isoOf(nowMs), adminUserId, null, null, applicationId]
      : ["rejected", isoOf(nowMs), adminUserId, decision.reason.trim(), isoOf(nowMs + RENEWAL_WAIT_MS), applicationId],
  );
  if (changed.meta.changes === 0) return { ok: false, reason: "not_pending", message: "The application is already decided." };
  const scopeUrl = settingsUrl(ports, name);
  if (decision.kind === "approve") {
    await notifyOwners(ports, scopeId, "verified-publisher-decision", { scope: name, decision: "granted", scopeUrl });
    await announceProofChange(ports, name, "verified_publisher_changed");
  } else {
    await notifyOwners(ports, scopeId, "verified-publisher-decision", { scope: name, decision: "denied", reason: decision.reason.trim(), scopeUrl });
  }
  return { ok: true, scope: name };
}

/** An approved status taken back; the proof, if any, still shows. */
export async function revokeVerified(ports: ProofPorts, scopeId: string, adminUserId: string, reason: string | null): Promise<DecisionResult> {
  const scope = (await ports.d1.query("select name from scopes where id = ?", [scopeId])).rows[0];
  if (!scope) return { ok: false, reason: "unknown", message: "No such scope." };
  const changed = await ports.d1.query("update vp_applications set state = 'revoked', decided_at = ?, decided_by = ? where scope_id = ? and state = 'approved'", [
    iso(ports), adminUserId, scopeId,
  ]);
  if (changed.meta.changes === 0) return { ok: false, reason: "not_pending", message: "The scope is not a Verified Publisher." };
  const name = String(scope.name);
  await notifyOwners(ports, scopeId, "verified-publisher-decision", { scope: name, decision: "revoked", reason, scopeUrl: settingsUrl(ports, name) });
  await announceProofChange(ports, name, "verified_publisher_changed");
  return { ok: true, scope: name };
}

export interface PendingApplication {
  id: string;
  scope: string;
  applied_at: string;
  applied_by: string;
  basis: "domain" | "github" | null;
}

/** The admin review queue's Verified Publisher items, oldest first (REQ-ADMIN-002). */
export async function pendingApplications(d1: D1): Promise<PendingApplication[]> {
  const { rows } = await d1.query(
    `select a.id, s.name as scope, a.applied_at, u.handle as applied_by, a.basis from vp_applications a
     join scopes s on s.id = a.scope_id join users u on u.id = a.applied_by where a.state = 'pending' order by a.applied_at, a.id`,
  );
  return rows.map((r) => ({ id: String(r.id), scope: String(r.scope), applied_at: String(r.applied_at), applied_by: String(r.applied_by), basis: (r.basis as PendingApplication["basis"]) ?? null }));
}

/** Organisations of the person whose application is pending: the "Needs you" item (REQ-SCOPE-018). */
export async function pendingApplicationsFor(d1: D1, userId: string): Promise<Array<{ scope: string; applied_at: string }>> {
  const { rows } = await d1.query(
    `select s.name as scope, a.applied_at from vp_applications a join scopes s on s.id = a.scope_id
     join scope_members m on m.scope_id = a.scope_id and m.user_id = ? and m.role = 'owner' where a.state = 'pending' order by a.applied_at`,
    [userId],
  );
  return rows.map((r) => ({ scope: String(r.scope), applied_at: String(r.applied_at) }));
}

export interface VerificationFacts {
  verified: boolean;
  /** Approved, but the last proof has lapsed: the status is suspended, not revoked, until a proof is restored. */
  verified_lapsed: boolean;
  verified_domain: string | null;
  verified_github_org: string | null;
  /** Set while the domain proof came from a domain another scope held within the previous year (REQ-SCOPE-007). */
  verified_domain_transferred_at: string | null;
}

/**
 * The verification facts every promoted version carries and every surface shows (REQ-VAL-041):
 * what the scope has proven and whether it holds Verified Publisher. The registry applies no policy to them.
 */
export async function verificationFacts(d1: D1, scopeId: string): Promise<VerificationFacts | null> {
  const [scope, approved, transfer] = await d1.batch([
    { sql: "select verified_domain, verified_github_org from scopes where id = ?", params: [scopeId] },
    { sql: "select 1 as hit from vp_applications where scope_id = ? and state = 'approved' limit 1", params: [scopeId] },
    { sql: "select transferred_at from domain_challenges where scope_id = ? and state = 'proven' limit 1", params: [scopeId] },
  ]);
  const row = scope!.rows[0];
  if (!row) return null;
  const hasProof = Boolean(row.verified_domain) || Boolean(row.verified_github_org);
  const isApproved = approved!.rows.length > 0;
  return {
    verified: isApproved && hasProof,
    verified_lapsed: isApproved && !hasProof,
    verified_domain: (row.verified_domain as string | null) ?? null,
    verified_github_org: (row.verified_github_org as string | null) ?? null,
    verified_domain_transferred_at: (transfer!.rows[0]?.transferred_at as string | null | undefined) ?? null,
  };
}
