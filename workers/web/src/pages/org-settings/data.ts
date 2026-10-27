import {
  applicationOf, authorize, missingConditions, domainProofsOf, githubProofOf, listPeople, ownedPacks,
  type ApplicationView, type DomainProofView, type GithubProofView, type Invitation, type Person, type ScopeRole, type ScopeRow,
} from "@packserver/core/scopes";
import { scopeMfaPolicy, type MfaPolicy } from "@packserver/core/identity";
import type { Context } from "hono";
import type { WebEnv } from "../../context";

export interface OrgSettings {
  scope: ScopeRow;
  role: ScopeRole;
  people: Person[];
  invitations: Invitation[];
  domain: DomainProofView;
  github: GithubProofView | null;
  application: ApplicationView;
  mfa: MfaPolicy;
  /** What a Verified Publisher application still lacks. */
  missing: Array<"proof" | "mfa">;
  packs: string[];
  now: number;
}

export type OrgResult = { kind: "found"; org: OrgSettings } | { kind: "not_found" } | { kind: "mfa_required"; scope: string };

/**
 * An organisation's settings for one of its owners or maintainers. Anyone else, and a personal
 * scope, gets the same answer as a scope that does not exist.
 */
export async function loadOrgSettings(c: Context<WebEnv>, name: string, userId: string): Promise<OrgResult> {
  const runtime = c.get("runtime");
  const { d1, clock } = runtime.ports;
  const decision = await authorize(d1, { scope: name, userId, need: "maintainer", resource: "private" });
  // Every answer reads the same things, so a stranger, a personal scope and an unknown name cost the same.
  const allowed = decision.kind === "allow" ? decision : undefined;
  const scope: ScopeRow = allowed?.scope ?? { id: "", name, kind: "org", state: "active", verified_domain: null, verified_github_org: null };
  const proofPorts = { d1 };
  const [people, domain, github, application, mfa, packs, missing] = await Promise.all([
    listPeople(d1, scope.id),
    domainProofsOf(proofPorts, scope.id),
    githubProofOf(proofPorts, scope.id),
    applicationOf(d1, scope.id),
    scopeMfaPolicy(d1, scope.id),
    ownedPacks(d1, scope),
    missingConditions(d1, scope.id, scope),
  ]);
  if (decision.kind === "mfa_required") return { kind: "mfa_required", scope: decision.scope };
  if (!allowed || scope.kind !== "org") return { kind: "not_found" };
  const role = allowed.role;
  return { kind: "found", org: { scope, role, ...people, domain, github, application, mfa, missing, packs, now: clock.now() } };
}
