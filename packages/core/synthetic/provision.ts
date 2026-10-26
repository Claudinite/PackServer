import type { D1 } from "@packserver/ports";
import { CANARY_SCOPE, PROBE_PACK, PROBE_SCOPE, PROBE_WORKFLOW, SYNTHETIC_KIND } from "./tenant.ts";

/** GitHub's immutable ids for the probe repository, as the OIDC token carries them. */
export interface ProbeRepository {
  /** `owner/name`; display only. */
  slug: string;
  id: string;
  ownerId: string;
}

export interface ProvisionedTenant {
  scopeId: string;
  registrationId: string;
  created: { scope: boolean; registration: boolean };
}

const DIGITS = /^[0-9]{1,20}$/;

/**
 * Makes `@probe` a synthetic scope whose one registered trusted publisher is the probe repository's
 * scheduled workflow, for the one pack `@probe/p`: a new version of it is accepted, a new pack is not,
 * because no registration names any other. Safe to run again; a repository that moved updates the row.
 * Refuses a `probe` scope of any other kind rather than adopt it.
 */
export async function provisionProbeTenant(d1: D1, input: { repository: ProbeRepository; nowMs: number; workflow?: string; scope?: string }): Promise<ProvisionedTenant> {
  const { repository } = input;
  const name = input.scope ?? PROBE_SCOPE;
  if (!DIGITS.test(repository.id) || !DIGITS.test(repository.ownerId)) throw new Error("the probe repository is named by GitHub's numeric ids");
  const now = new Date(input.nowMs).toISOString();

  const existing = (await d1.query(`select id, kind from scopes where name = ?`, [name])).rows[0] as { id: string; kind: string } | undefined;
  if (existing && existing.kind !== SYNTHETIC_KIND) throw new Error(`@${name} exists as a ${existing.kind} scope and will not be taken over`);
  const scopeId = existing?.id ?? `scope-synthetic-${name}`;
  const registered = (await d1.query(`select id from trusted_publishers where scope_id = ? and pack_name = ?`, [scopeId, PROBE_PACK])).rows[0] as { id: string } | undefined;
  const registrationId = registered?.id ?? `tp-synthetic-${name}`;

  await d1.batch([
    { sql: `insert or ignore into scopes (id, name, kind, state, created_at) values (?, ?, ?, 'active', ?)`, params: [scopeId, name, SYNTHETIC_KIND, now] },
    {
      sql: `insert or ignore into trusted_publishers (id, scope_id, pack_name, repository_id, repository_owner_id, repository, workflow, environment, path, refs, events, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, null, '.', ?, ?, ?, ?)`,
      params: [registrationId, scopeId, PROBE_PACK, repository.id, repository.ownerId, repository.slug, input.workflow ?? PROBE_WORKFLOW, JSON.stringify(["refs/heads/main"]), JSON.stringify(["schedule", "workflow_dispatch"]), now, now],
    },
    {
      sql: `update trusted_publishers set repository_id = ?, repository_owner_id = ?, repository = ?, workflow = ?, updated_at = ?
             where id = ? and (repository_id <> ? or repository_owner_id <> ? or repository <> ? or workflow <> ?)`,
      params: [repository.id, repository.ownerId, repository.slug, input.workflow ?? PROBE_WORKFLOW, now, registrationId, repository.id, repository.ownerId, repository.slug, input.workflow ?? PROBE_WORKFLOW],
    },
  ]);
  return { scopeId, registrationId, created: { scope: !existing, registration: !registered } };
}

export interface ProvisionedCanary {
  scopeId: string;
  created: boolean;
}

/**
 * Creates the owner's `@packserver-canary` org, which the reserved-name check keeps out of the
 * ordinary creation path, with the given account as its owner. Safe to run again. A scope of that name
 * that this function did not create is refused rather than adopted.
 */
export async function provisionCanaryScope(d1: D1, input: { ownerUserId: string; nowMs: number; scope?: string }): Promise<ProvisionedCanary> {
  const name = input.scope ?? CANARY_SCOPE;
  const scopeId = `scope-canary-${name}`;
  const now = new Date(input.nowMs).toISOString();

  const existing = (await d1.query(`select id, kind from scopes where name = ?`, [name])).rows[0] as { id: string; kind: string } | undefined;
  if (existing && (existing.id !== scopeId || existing.kind !== "org")) throw new Error(`@${name} exists and was not created by this provisioning; it will not be taken over`);

  if (existing) {
    const owners = (await d1.query(`select user_id from scope_members where scope_id = ? and role = 'owner'`, [scopeId])).rows as Array<{ user_id: string }>;
    if (owners.some((o) => o.user_id !== input.ownerUserId)) throw new Error(`@${name} is owned by another account; it will not be given a second owner`);
  }

  await d1.batch([
    { sql: `insert or ignore into scopes (id, name, kind, state, created_at) values (?, ?, 'org', 'active', ?)`, params: [scopeId, name, now] },
    { sql: `insert or ignore into scope_members (scope_id, user_id, role, created_at) values (?, ?, 'owner', ?)`, params: [scopeId, input.ownerUserId, now] },
  ]);
  return { scopeId, created: !existing };
}
