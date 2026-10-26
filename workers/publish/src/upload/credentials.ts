import { base64url } from "jose";
import { CREDENTIAL_TTL_MS, dryRunStagingKey, objectExpiry, stagingKey, type StagingLifetime } from "@packserver/core/publishing";
import type { Clock, D1, Rng } from "@packserver/ports";

export const CREDENTIAL_PREFIX = "psu_";

export interface CredentialRow {
  id: string;
  source: "oidc" | "upload";
  scope_id: string;
  scope: string;
  pack_name: string;
  version: string;
  user_id: string | null;
  trusted_publisher_id: string | null;
  staging_key: string;
  lifetime: StagingLifetime;
  expires_at: string;
  used_at: string | null;
  uploaded_at: string | null;
  size_bytes: number | null;
}

const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const toBase64Url = (bytes: Uint8Array): string => base64url.encode(bytes);

export async function hashSecret(secret: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))));
}

export interface IssueRequest {
  source: "oidc" | "upload";
  scope: { id: string; name: string };
  packName: string;
  version: string;
  lifetime: StagingLifetime;
  trustedPublisherId?: string;
  userId?: string;
  claims?: Record<string, unknown>;
  /** The OIDC token's `jti`; a second credential for the same token is refused. */
  oidcJti?: string;
}

export class TokenAlreadyUsed extends Error {}

export interface Issued {
  id: string;
  secret: string;
  expiresAt: string;
  stagingKey: string;
}

/** Mints a credential whose secret is returned once and stored only as a hash. */
export async function issueCredential(ports: { d1: D1; rng: Rng; clock: Clock }, request: IssueRequest): Promise<Issued> {
  const id = ports.rng.uuid().replace(/-/g, "");
  const secret = `${CREDENTIAL_PREFIX}${toBase64Url(ports.rng.bytes(32))}`;
  const now = ports.clock.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CREDENTIAL_TTL_MS).toISOString();
  const key = (request.lifetime === "dry-run" ? dryRunStagingKey : stagingKey)(request.scope.name, request.packName, request.version, id);
  try {
    await ports.d1.query(
      `insert into upload_credentials (id, secret_hash, source, scope_id, pack_name, version, trusted_publisher_id, user_id, claims, oidc_jti, staging_key, lifetime, issued_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, await hashSecret(secret), request.source, request.scope.id, request.packName, request.version,
        request.trustedPublisherId ?? null, request.userId ?? null, request.claims ? JSON.stringify(request.claims) : null,
        request.oidcJti ?? null, key, request.lifetime, issuedAt, expiresAt,
      ],
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: upload_credentials\.oidc_jti/.test(error.message)) throw new TokenAlreadyUsed();
    throw error;
  }
  return { id, secret, expiresAt, stagingKey: key };
}

export type Lookup =
  | { ok: true; credential: CredentialRow }
  | { ok: false; why: "unknown" | "expired" | "wrong-pack" };

/** The credential a bearer secret names, whatever it is bound to. */
export async function credentialBySecret(ports: { d1: D1 }, secret: string): Promise<CredentialRow | null> {
  const { rows } = await ports.d1.query(
    `select c.id, c.source, c.scope_id, s.name as scope, c.pack_name, c.version, c.user_id, c.trusted_publisher_id, c.staging_key, c.lifetime, c.expires_at, c.used_at, c.uploaded_at, c.size_bytes
     from upload_credentials c join scopes s on s.id = c.scope_id where c.secret_hash = ?`,
    [await hashSecret(secret)],
  );
  return (rows[0] as unknown as CredentialRow | undefined) ?? null;
}

/** The credential a bearer secret names, if it is bound to this pack and version and still within its 15 minutes. */
export async function lookupCredential(
  ports: { d1: D1; clock: Clock },
  secret: string,
  bound: { scope: string; packName: string; version: string },
  options: { allowExpired?: boolean } = {},
): Promise<Lookup> {
  const row = await credentialBySecret(ports, secret);
  if (!row) return { ok: false, why: "unknown" };
  if (row.scope !== bound.scope || row.pack_name !== bound.packName || row.version !== bound.version) return { ok: false, why: "wrong-pack" };
  if (!options.allowExpired && ports.clock.now() >= Date.parse(row.expires_at)) return { ok: false, why: "expired" };
  return { ok: true, credential: row };
}

export type Spend = "spent" | "used" | "over-cap";

/**
 * Spends the credential on one presigned URL and checks the scope's staging cap in the same
 * statement, so parallel presigns cannot each see room that only one of them may take. Every
 * spent, unreleased credential counts until its object expires, whether or not its upload was confirmed.
 */
export async function spendCredential(
  ports: { d1: D1; clock: Clock },
  credential: CredentialRow,
  contentLength: number,
  capBytes: number,
): Promise<Spend> {
  const now = ports.clock.now();
  const nowIso = new Date(now).toISOString();
  const { meta } = await ports.d1.query(
    `update upload_credentials set used_at = ?, size_bytes = ?, object_expires_at = ?
     where id = ? and used_at is null
       and ? + (select coalesce(sum(size_bytes), 0) from upload_credentials
                where scope_id = ? and id != ? and released_at is null and size_bytes is not null and object_expires_at > ?) <= ?`,
    [nowIso, contentLength, new Date(objectExpiry(now, credential.lifetime)).toISOString(), credential.id, contentLength, credential.scope_id, credential.id, nowIso, capBytes],
  );
  if (meta.changes === 1) return "spent";
  const { rows } = await ports.d1.query(`select used_at from upload_credentials where id = ?`, [credential.id]);
  return rows[0]?.used_at ? "used" : "over-cap";
}

/** Bytes a scope holds in staging, for the refusal's message. */
export async function heldBytes(ports: { d1: D1; clock: Clock }, scopeId: string): Promise<number> {
  const { rows } = await ports.d1.query(
    `select coalesce(sum(size_bytes), 0) as held from upload_credentials
     where scope_id = ? and released_at is null and size_bytes is not null and object_expires_at > ?`,
    [scopeId, new Date(ports.clock.now()).toISOString()],
  );
  return Number(rows[0]?.held ?? 0);
}
