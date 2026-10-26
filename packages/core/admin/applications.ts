import { createHash } from "node:crypto";
import { iso, newId } from "../scopes/personal.ts";
import { announceProofChange, notifyOwners, settingsUrl } from "../scopes/proofs/context.ts";
import { decideApplication, pendingApplications, revokeVerified, type PendingApplication } from "../scopes/verified-publisher.ts";
import { actorOf, MAX_REASON, type AdminIdentity, type AdminPorts } from "./ports.ts";

/** The account row an admin's decisions are recorded under: made on first use, keyed by the Access subject, and with no handle or sign-in. */
export async function adminUserId(ports: Pick<AdminPorts, "d1" | "clock">, admin: AdminIdentity): Promise<string> {
  const id = `admin-${createHash("sha256").update(admin.sub).digest("hex").slice(0, 24)}`;
  await ports.d1.query("insert or ignore into users (id, created_at) values (?, ?)", [id, iso(ports)]);
  return id;
}

export const applicationQueue = (ports: Pick<AdminPorts, "d1">): Promise<PendingApplication[]> => pendingApplications(ports.d1);

export type VerifiedDecision = { kind: "approve" } | { kind: "deny"; reason: string };

export type ApplicationOutcome =
  | { ok: true; scope: string }
  | { ok: false; reason: "unknown" | "not_pending" | "reason_required" | "reason_too_long" | "missing_conditions" | "not_verified" | "already_verified"; message: string };

/** Approving or denying an application; the proof and MFA conditions are checked again at approval, so a lapsed proof stops it. */
export async function decideVerifiedApplication(ports: AdminPorts, applicationId: string, admin: AdminIdentity, decision: VerifiedDecision): Promise<ApplicationOutcome> {
  if (decision.kind === "deny" && decision.reason.trim().length > MAX_REASON) return { ok: false, reason: "reason_too_long", message: `A reason is at most ${MAX_REASON} characters.` };
  const result = await decideApplication(ports, applicationId, await adminUserId(ports, admin), decision);
  if (!result.ok) return result;
  await ports.audit(actorOf(admin), "admin.action", `scope:@${result.scope}`, { detail: { verb: `verified.${decision.kind}` } });
  return result;
}

/** Takes the status back; the scope keeps whatever proof it holds. */
export async function revokeVerifiedPublisher(ports: AdminPorts, scopeName: string, admin: AdminIdentity, reason: string | null): Promise<ApplicationOutcome> {
  if (reason && reason.length > MAX_REASON) return { ok: false, reason: "reason_too_long", message: `A reason is at most ${MAX_REASON} characters.` };
  const scope = (await ports.d1.query("select id from scopes where name = ?", [scopeName])).rows[0];
  if (!scope) return { ok: false, reason: "unknown", message: "No such scope." };
  const result = await revokeVerified(ports, String(scope.id), await adminUserId(ports, admin), reason);
  if (!result.ok) return { ...result, reason: result.reason === "not_pending" ? "not_verified" : result.reason };
  await ports.audit(actorOf(admin), "admin.action", `scope:@${result.scope}`, { detail: { verb: "verified.revoke" } });
  return result;
}

/**
 * Grants the status with no application, for the registry's own scopes among others. The record it leaves is an approved
 * application, so every surface reads the two paths alike (REQ-ADMIN-004); no payment is involved (REQ-PAY-018).
 */
export async function grantVerifiedPublisher(ports: AdminPorts, scopeName: string, admin: AdminIdentity): Promise<ApplicationOutcome> {
  const scope = (await ports.d1.query("select id, verified_domain, verified_github_org from scopes where name = ?", [scopeName])).rows[0];
  if (!scope) return { ok: false, reason: "unknown", message: "No such scope." };
  const scopeId = String(scope.id);
  if ((await ports.d1.query("select 1 from vp_applications where scope_id = ? and state = 'approved'", [scopeId])).rows.length > 0) {
    return { ok: false, reason: "already_verified", message: `${scopeName} is already a Verified Publisher.` };
  }
  const by = await adminUserId(ports, admin);
  const at = iso(ports);
  const settled = await ports.d1.query("update vp_applications set state = 'approved', decided_at = ?, decided_by = ?, denial_reason = null, renewable_at = null where scope_id = ? and state = 'pending'", [at, by, scopeId]);
  if (settled.meta.changes === 0) {
    await ports.d1.query("insert into vp_applications (id, scope_id, state, applied_by, applied_at, decided_at, decided_by, basis) values (?, ?, 'approved', ?, ?, ?, ?, ?)", [
      newId(ports), scopeId, by, at, at, by, scope.verified_domain ? "domain" : scope.verified_github_org ? "github" : null,
    ]);
  }
  await notifyOwners(ports, scopeId, "verified-publisher-decision", { scope: scopeName, decision: "granted", scopeUrl: settingsUrl(ports, scopeName) });
  await announceProofChange(ports, scopeName, "verified_publisher_changed");
  await ports.audit(actorOf(admin), "admin.action", `scope:@${scopeName}`, { detail: { verb: "verified.grant" } });
  return { ok: true, scope: scopeName };
}
