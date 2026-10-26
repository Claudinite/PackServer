import type { D1 } from "@packserver/ports";
import { MFA_POLICIES } from "@packserver/schema/db";
import { hasPasskey } from "./assertion.ts";

export { MFA_POLICIES };
export type MfaPolicy = (typeof MFA_POLICIES)[number];

export const isMfaPolicy = (value: unknown): value is MfaPolicy => (MFA_POLICIES as readonly unknown[]).includes(value);

export async function scopeMfaPolicy(d1: D1, scopeId: string): Promise<MfaPolicy> {
  const { rows } = await d1.query("select policy from scope_mfa_policies where scope_id = ?", [scopeId]);
  const policy = rows[0]?.policy;
  return isMfaPolicy(policy) ? policy : "none";
}

export async function setScopeMfaPolicy(ports: { d1: D1; clock: { now(): number } }, scopeId: string, policy: MfaPolicy, by: string): Promise<void> {
  await ports.d1.query(
    `insert into scope_mfa_policies (scope_id, policy, set_by, set_at) values (?1, ?2, ?3, ?4)
     on conflict (scope_id) do update set policy = ?2, set_by = ?3, set_at = ?4`,
    [scopeId, policy, by, new Date(ports.clock.now()).toISOString()],
  );
}

/**
 * Whether the person lacks what the scope requires of everyone acting for it. Passkeys are the only
 * factor today, so "mfa" and "passkey" ask the same of a person; TOTP will tell them apart.
 */
export async function lacksRequiredFactor(d1: D1, scopeId: string, userId: string): Promise<boolean> {
  if ((await scopeMfaPolicy(d1, scopeId)) === "none") return false;
  return !(await hasPasskey(d1, userId));
}
