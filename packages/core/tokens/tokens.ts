import type { Clock, D1, Rng } from "@packserver/ports";
import { parseCidr, inAnyCidr, type Cidr } from "./cidr.ts";
import { DAY_MS, DEFAULT_LIFETIME_DAYS, LAST_USED_RESOLUTION_MS, MAX_LIFETIME_DAYS, generateToken, hashToken, looksLikeToken, tokenHint } from "./token.ts";

export interface TokenPorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

const MAX_CIDRS = 16;
const MAX_LABEL = 80;
/** Roles that may hand out read access to a scope's private packs. */
const MINTING_ROLES = ["owner", "maintainer"] as const;

export interface MintInput {
  userId: string;
  /** Scope name without the `@`. */
  scope: string;
  /** Pack name without the scope; absent restricts the token to the scope's packs. */
  pack?: string;
  lifetimeDays?: number;
  cidr?: readonly string[];
  label?: string;
}

export type MintRefusal = "lifetime" | "cidr" | "label" | "not-found";

export interface TokenView {
  id: string;
  hint: string;
  label: string | null;
  kind: "read";
  scope: string;
  pack: string | null;
  cidr: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  status: "active" | "expired" | "revoked";
}

export type MintResult = { ok: true; token: string; view: TokenView } | { ok: false; reason: MintRefusal };

const iso = (ms: number) => new Date(ms).toISOString();

function viewOf(row: Record<string, unknown>, now: number): TokenView {
  const revoked = row.revoked_at as string | null;
  const expires = row.expires_at as string;
  return {
    id: row.id as string,
    hint: row.hint as string,
    label: (row.label as string | null) ?? null,
    kind: "read",
    scope: row.scope as string,
    pack: (row.pack as string | null) ?? null,
    cidr: row.cidr ? (JSON.parse(row.cidr as string) as string[]) : [],
    created_at: row.created_at as string,
    expires_at: expires,
    last_used_at: (row.last_used_at as string | null) ?? null,
    revoked_at: revoked,
    revoked_reason: (row.revoked_reason as string | null) ?? null,
    status: revoked ? "revoked" : Date.parse(expires) <= now ? "expired" : "active",
  };
}

const SELECT_VIEW = `select t.id, t.hint, t.label, t.cidr, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, t.revoked_reason, s.name as scope, p.name as pack
  from read_tokens t join scopes s on s.id = t.scope_id left join packs p on p.id = t.pack_id`;

/**
 * Mints a read token for a person who may manage the scope. The value is returned here and never
 * again; only its hash is stored. A scope or pack the person cannot manage reads as not found.
 */
export async function mintToken(ports: TokenPorts, input: MintInput): Promise<MintResult> {
  const days = input.lifetimeDays ?? DEFAULT_LIFETIME_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_LIFETIME_DAYS) return { ok: false, reason: "lifetime" };
  const blocks: Cidr[] = [];
  for (const text of input.cidr ?? []) {
    const block = parseCidr(text);
    if (!block) return { ok: false, reason: "cidr" };
    blocks.push(block);
  }
  if ((input.cidr?.length ?? 0) > MAX_CIDRS) return { ok: false, reason: "cidr" };
  if (input.label !== undefined && (input.label.length > MAX_LABEL || /[\u0000-\u001f]/.test(input.label))) return { ok: false, reason: "label" };

  const roles = MINTING_ROLES.map(() => "?").join(", ");
  const target = await ports.d1.query(
    `select s.id as scope_id, p.id as pack_id from scopes s
       join scope_members m on m.scope_id = s.id and m.user_id = ? and m.role in (${roles})
       left join packs p on p.scope_id = s.id and p.name = ?
      where s.name = ?`,
    [input.userId, ...MINTING_ROLES, input.pack ?? "", input.scope],
  );
  const row = target.rows[0];
  if (!row || (input.pack !== undefined && row.pack_id === null)) return { ok: false, reason: "not-found" };

  const now = ports.clock.now();
  const token = generateToken(ports.rng);
  const id = ports.rng.uuid();
  await ports.d1.query(
    "insert into read_tokens (id, user_id, kind, token_hash, hint, label, scope_id, pack_id, cidr, created_at, expires_at) values (?, ?, 'read', ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id, input.userId, await hashToken(token), tokenHint(token), input.label ?? null, row.scope_id,
      input.pack === undefined ? null : row.pack_id, input.cidr && input.cidr.length > 0 ? JSON.stringify(input.cidr) : null,
      iso(now), iso(now + days * DAY_MS),
    ],
  );
  const view = (await listTokens(ports, input.userId)).find((t) => t.id === id)!;
  return { ok: true, token, view };
}

/** The person's tokens, newest first, with their last-used time. */
export async function listTokens(ports: Pick<TokenPorts, "d1" | "clock">, userId: string): Promise<TokenView[]> {
  const { rows } = await ports.d1.query(`${SELECT_VIEW} where t.user_id = ? order by t.created_at desc, t.id`, [userId]);
  const now = ports.clock.now();
  return rows.map((r) => viewOf(r, now));
}

/** Revokes one of the person's own tokens; false when it is not theirs or is already revoked. */
export async function revokeToken(ports: Pick<TokenPorts, "d1" | "clock">, userId: string, id: string): Promise<boolean> {
  const { meta } = await ports.d1.query(
    "update read_tokens set revoked_at = ?, revoked_reason = 'owner' where id = ? and user_id = ? and revoked_at is null",
    [iso(ports.clock.now()), id, userId],
  );
  return meta.changes > 0;
}

/** What a presented token may read: the scope, and the one pack when it has one. */
export interface TokenGrant {
  id: string;
  user_id: string;
  scope: string;
  pack: string | null;
}

/**
 * The grant a presented value stands for, or null. Unknown, malformed, revoked, expired and
 * out-of-range tokens are all null, so a caller cannot tell them apart. A successful use moves the
 * last-used time when the stored one is an hour old or more.
 */
export async function authenticateToken(ports: Pick<TokenPorts, "d1" | "clock">, presented: string, ip: string): Promise<TokenGrant | null> {
  if (!looksLikeToken(presented)) return null;
  const { rows } = await ports.d1.query(
    `select t.id, t.user_id, t.cidr, t.expires_at, t.revoked_at, s.name as scope, p.name as pack
       from read_tokens t join scopes s on s.id = t.scope_id left join packs p on p.id = t.pack_id
      where t.token_hash = ?`,
    [await hashToken(presented)],
  );
  const row = rows[0];
  const now = ports.clock.now();
  if (!row || row.revoked_at !== null || Date.parse(row.expires_at as string) <= now) return null;
  if (row.cidr !== null) {
    const blocks = (JSON.parse(row.cidr as string) as string[]).flatMap((c) => parseCidr(c) ?? []);
    if (!inAnyCidr(ip, blocks)) return null;
  }
  await ports.d1.query(
    "update read_tokens set last_used_at = ? where id = ? and (last_used_at is null or last_used_at <= ?)",
    [iso(now), row.id, iso(now - LAST_USED_RESOLUTION_MS)],
  );
  return { id: row.id as string, user_id: row.user_id as string, scope: row.scope as string, pack: (row.pack as string | null) ?? null };
}

/** Whether a grant reaches a pack: a pack restriction names exactly that pack, a scope restriction any pack of the scope. */
export const grantCovers = (grant: TokenGrant, target: { scope: string; pack: string }): boolean =>
  grant.scope === target.scope && (grant.pack === null || grant.pack === target.pack);

/**
 * Revokes the token a leak report presents in full. Anything else, a prefix included, changes nothing;
 * the caller answers the same either way.
 */
export async function reportLeak(ports: Pick<TokenPorts, "d1" | "clock">, presented: unknown): Promise<void> {
  if (typeof presented !== "string" || !looksLikeToken(presented)) return;
  await ports.d1.query(
    "update read_tokens set revoked_at = ?, revoked_reason = 'leak-reported' where token_hash = ? and revoked_at is null",
    [iso(ports.clock.now()), await hashToken(presented)],
  );
}
