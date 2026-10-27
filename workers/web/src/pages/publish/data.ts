import type { Context } from "hono";
import type { WebEnv } from "../../context";

export interface WizardPack {
  /** `@scope/name`. */
  full: string;
  scope: string;
  name: string;
  /** Whether the pack already has a registry row; a new pack is the one a price would apply to. */
  exists: boolean;
  visibility: "public" | "private" | null;
}

export interface WizardDraft {
  version: string;
  credentialId: string;
  sizeBytes: number | null;
  uploadedAt: string;
  expired: boolean;
}

export interface WizardLastRun {
  id: string;
  version: string;
  verdict: string | null;
}

export interface WizardState {
  /** The scopes the person may publish to, personal scope first. */
  scopes: string[];
  pack: WizardPack | null;
  draft: WizardDraft | null;
  /** The newest publish run for the pack that did not pass, whose version can be tried again. */
  lastRun: WizardLastRun | null;
}

const PACK = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;

export function splitPack(full: string): { scope: string; name: string } | null {
  const m = PACK.exec(full);
  return m ? { scope: m[1]!, name: m[2]! } : null;
}

/** The scopes a person publishes to: owner or maintainer, never the synthetic tenant. */
export async function writableScopes(c: Context<WebEnv>, userId: string): Promise<string[]> {
  const { d1 } = c.get("runtime").ports;
  const { rows } = await d1.query(
    `select s.name from scope_members m join scopes s on s.id = m.scope_id
      where m.user_id = ? and m.role in ('owner', 'maintainer') and s.kind != 'synthetic'
      order by (s.kind = 'user') desc, s.name`,
    [userId],
  );
  return rows.map((r) => String(r.name));
}

/** A pack the person may publish to, or null when the name is malformed or the person has no standing there. */
export async function lookupPack(c: Context<WebEnv>, userId: string, full: string): Promise<WizardPack | null> {
  const parts = splitPack(full);
  if (!parts) return null;
  const { d1 } = c.get("runtime").ports;
  const { rows } = await d1.query(
    `select s.id as scope_id, p.visibility from scope_members m join scopes s on s.id = m.scope_id
       left join packs p on p.scope_id = s.id and p.name = ?
      where s.name = ? and m.user_id = ? and m.role in ('owner', 'maintainer')`,
    [parts.name, parts.scope, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return { full, ...parts, exists: row.visibility !== null && row.visibility !== undefined, visibility: row.visibility === "private" ? "private" : row.visibility === "public" ? "public" : null };
}

/** What the wizard opens with: the person's scopes and, for `?pack=`, the pack, its waiting draft and the attempt to retry. */
export async function loadWizard(c: Context<WebEnv>, userId: string, requested: string | undefined): Promise<WizardState> {
  const { d1, clock } = c.get("runtime").ports;
  const scopes = await writableScopes(c, userId);
  const pack = requested ? await lookupPack(c, userId, requested) : null;
  if (!pack) return { scopes, pack: null, draft: null, lastRun: null };
  const now = new Date(clock.now()).toISOString();
  const [draft, last] = await d1.batch([
    {
      sql: `select u.id, u.version, u.size_bytes, u.uploaded_at, u.released_at, u.object_expires_at
              from upload_credentials u join scopes s on s.id = u.scope_id
             where u.user_id = ? and s.name = ? and u.pack_name = ? and u.lifetime = 'draft' and u.uploaded_at is not null
               and not exists (select 1 from validation_runs r where r.credential_id = u.id)
             order by u.issued_at desc, u.id desc limit 1`,
      params: [userId, pack.scope, pack.name],
    },
    {
      sql: `select r.id, r.version, r.verdict from validation_runs r join scopes s on s.id = r.scope_id
             where s.name = ? and r.pack_name = ? and r.kind = 'publish' and r.synthetic = 0 and r.status = 'finished' and r.verdict in ('fail', 'error')
             order by r.created_at desc, r.id desc limit 1`,
      params: [pack.scope, pack.name],
    },
  ]);
  const d = draft!.rows[0];
  const l = last!.rows[0];
  return {
    scopes,
    pack,
    draft: d
      ? {
          version: String(d.version),
          credentialId: String(d.id),
          sizeBytes: d.size_bytes === null ? null : Number(d.size_bytes),
          uploadedAt: String(d.uploaded_at),
          expired: d.released_at !== null || (d.object_expires_at !== null && String(d.object_expires_at) <= now),
        }
      : null,
    lastRun: l ? { id: String(l.id), version: String(l.version), verdict: l.verdict === null ? null : String(l.verdict) } : null,
  };
}
