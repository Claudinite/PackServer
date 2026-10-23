import { base64url } from "jose";
import { CREDENTIAL_TTL_MS, objectExpiry, stagingKey, type StagingLifetime } from "@packserver/core/publishing";
import type { Clock, D1, Rng } from "@packserver/ports";

export const CREDENTIAL_PREFIX = "psu_";

export interface CredentialRow {
  id: string;
  source: "oidc" | "upload";
  scope_id: string;
  scope: string;
  pack_name: string;
  version: string;
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
}

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
  const key = stagingKey(request.scope.name, request.packName, request.version, id);
  await ports.d1.query(
    `insert into upload_credentials (id, secret_hash, source, scope_id, pack_name, version, trusted_publisher_id, user_id, claims, staging_key, lifetime, issued_at, expires_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, await hashSecret(secret), request.source, request.scope.id, request.packName, request.version,
      request.trustedPublisherId ?? null, request.userId ?? null, request.claims ? JSON.stringify(request.claims) : null,
      key, request.lifetime, issuedAt, expiresAt,
    ],
  );
  return { id, secret, expiresAt, stagingKey: key };
}

export type Lookup =
  | { ok: true; credential: CredentialRow }
  | { ok: false; why: "unknown" | "expired" | "wrong-pack" };

/** The credential a bearer secret names, if it is bound to this pack and version and still within its 15 minutes. */
export async function lookupCredential(
  ports: { d1: D1; clock: Clock },
  secret: string,
  bound: { scope: string; packName: string; version: string },
): Promise<Lookup> {
  const { rows } = await ports.d1.query(
    `select c.id, c.source, c.scope_id, s.name as scope, c.pack_name, c.version, c.staging_key, c.lifetime, c.expires_at, c.used_at, c.uploaded_at, c.size_bytes
     from upload_credentials c join scopes s on s.id = c.scope_id where c.secret_hash = ?`,
    [await hashSecret(secret)],
  );
  const row = rows[0] as unknown as CredentialRow | undefined;
  if (!row) return { ok: false, why: "unknown" };
  if (row.scope !== bound.scope || row.pack_name !== bound.packName || row.version !== bound.version) return { ok: false, why: "wrong-pack" };
  if (ports.clock.now() >= Date.parse(row.expires_at)) return { ok: false, why: "expired" };
  return { ok: true, credential: row };
}

/** Spends the credential on one presigned URL; false when another request spent it first. */
export async function spendCredential(
  ports: { d1: D1; clock: Clock },
  credential: CredentialRow,
  contentLength: number,
): Promise<boolean> {
  const now = ports.clock.now();
  const { meta } = await ports.d1.query(
    `update upload_credentials set used_at = ?, size_bytes = ?, object_expires_at = ? where id = ? and used_at is null`,
    [new Date(now).toISOString(), contentLength, new Date(objectExpiry(now, credential.lifetime)).toISOString(), credential.id],
  );
  return meta.changes === 1;
}

/** Bytes a scope holds in staging: confirmed objects, and URLs still valid that may yet be used. */
export async function heldBytes(ports: { d1: D1; clock: Clock }, scopeId: string, exceptCredential: string): Promise<number> {
  const { rows } = await ports.d1.query(
    `select coalesce(sum(size_bytes), 0) as held from upload_credentials
     where scope_id = ? and id != ? and released_at is null and size_bytes is not null and (uploaded_at is not null or expires_at > ?)`,
    [scopeId, exceptCredential, new Date(ports.clock.now()).toISOString()],
  );
  return Number(rows[0]?.held ?? 0);
}
