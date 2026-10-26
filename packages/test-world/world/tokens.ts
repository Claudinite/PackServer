import { authenticateToken, grantCovers } from "@packserver/core/tokens";
import type { D1, D1Result } from "@packserver/ports";
import type { ApiResponse, Driver } from "../drivers/driver";
import type { Aliases } from "./alias";
import { InfrastructureError } from "./errors";
import { NotFound, Refusal, type Observation, type RefusalReason } from "./outcomes";
import type { Pack, Session, Sensitive, User } from "./types";

type Statement = { all(): Promise<{ results?: Array<Record<string, unknown>>; meta?: { changes?: number; last_row_id?: number } }> };

/** Only `query` is used by the token gate. */
function d1Over(db: unknown): D1 {
  const prepare = (db as { prepare(sql: string): { bind(...values: unknown[]): Statement } }).prepare.bind(db);
  return {
    async query(sql, params = []): Promise<D1Result> {
      const out = await prepare(sql).bind(...params).all();
      return { rows: out.results ?? [], meta: { changes: out.meta?.changes ?? 0, last_row_id: out.meta?.last_row_id ?? null } };
    },
    batch: () => Promise.reject(new InfrastructureError("the world's token gate does not batch")),
  };
}

const DEFAULT_ADDRESS = "203.0.113.1";
const MINT_ACTION = "token.mint";

export interface MintOpts extends Sensitive {
  /** A token restricted to this pack. */
  read?: Pack;
  /** A token restricted to every pack of this scope, named as the scenario names it. */
  readScope?: string;
  lifetimeDays?: number;
  cidr?: string[];
  label?: string;
  /** The kind the request names; only `read` exists, so any other is a negative. */
  kind?: string;
}

/** What minting returns: the value appears here and nowhere else. */
export interface MintedToken {
  readonly value: string;
  readonly id: string;
  readonly expiresAt: Date;
}

export interface TokenInfo {
  readonly id: string;
  readonly hint: string;
  readonly label: string | null;
  readonly pack: string | null;
  readonly scope: string;
  readonly cidr: readonly string[];
  readonly expiresAt: Date;
  readonly lastUsed: Date | null;
  readonly status: "active" | "expired" | "revoked";
  readonly revokedReason: string | null;
}

/** The token verbs of a signed-in person (REQ-PUB-012). */
export interface UserTokens {
  mint(opts: MintOpts): Promise<MintedToken>;
  list(): Promise<TokenInfo[]>;
  revoke(token: MintedToken | TokenInfo): Promise<void>;
}

export interface UseOpts {
  /** The address the call comes from. */
  from?: string;
}

/** Things a token must never do; each is a sensitive or account action the token has no business with. */
export type TokenAttempt = "publish" | "yank" | "mintToken" | "setVisibility" | "listSessions" | "showAccount" | "changeEmail" | "approveStaged";

/** Tokens as seen from outside any account: CI that holds one, and a visitor who found one. */
export interface WorldTokens {
  /** The public leak-report form, for a token, a prefix of one, or any text; refused only when the address has reported too much. */
  leakReport(tokenOrPrefix: string, o?: { from?: string }): Promise<Observation | Refusal>;
  /** Whether the token reads a pack: the token's own gate, which CI asks before it relies on one. */
  canRead(token: MintedToken | string, pack: Pack, o?: UseOpts): Promise<"readable" | NotFound | Refusal>;
  /** What happens when the token, as the only credential, tries an action it must never have. */
  attempt(token: MintedToken | string, action: TokenAttempt, pack: Pack): Promise<"refused" | "allowed">;
  /** Makes the person an owner of the pack's scope, standing in for the scope verbs that arrive with the scopes area. */
  seedOwner(user: User, pack: Pack): Promise<void>;
}

/** What the person's own verbs need from the account that owns them. */
export interface TokenActor {
  send(req: { method: string; path: string; session?: Session | undefined; json?: unknown; headers?: Record<string, string> }): Promise<ApiResponse>;
  formHeaders(session: Session | undefined): Promise<Record<string, string>>;
  session(): Session | undefined;
  assertionHeaders(action: string, o?: Sensitive): Promise<Record<string, string>>;
  refused(res: ApiResponse, what: string): Refusal;
  aliases: Aliases;
}

const valueOf = (token: MintedToken | string): string => (typeof token === "string" ? token : token.value);

const observe = (res: ApiResponse): Observation => ({
  status: res.status,
  headers: Object.fromEntries([...res.headers].filter(([name]) => name !== "date" && name !== "set-cookie")),
  body: res.text,
});

export function createUserTokens(actor: TokenActor): UserTokens {
  return {
    async mint(opts) {
      const assertion = await actor.assertionHeaders(MINT_ACTION, opts);
      const session = actor.session();
      const target = opts.read ? { pack: opts.read.systemName } : opts.readScope ? { scope: `@${actor.aliases.alias(opts.readScope)}` } : {};
      const res = await actor.send({
        method: "POST",
        path: "/api/tokens",
        session,
        json: {
          ...(opts.kind === undefined ? {} : { kind: opts.kind }),
          ...target,
          ...(opts.lifetimeDays === undefined ? {} : { lifetime_days: opts.lifetimeDays }),
          ...(opts.cidr === undefined ? {} : { cidr: opts.cidr }),
          ...(opts.label === undefined ? {} : { label: opts.label }),
        },
        headers: { ...(await actor.formHeaders(session)), ...assertion },
      });
      if (res.status === 404) return Promise.reject(new Refusal("forbidden", { message: "not found" }));
      if (res.status !== 201) throw actor.refused(res, "tokens.mint");
      const body = res.json() as { token: string; id: string; expires_at: string };
      return { value: body.token, id: body.id, expiresAt: new Date(body.expires_at) };
    },
    async list() {
      const res = await actor.send({ method: "GET", path: "/api/tokens", session: actor.session() });
      if (res.status !== 200) throw actor.refused(res, "tokens.list");
      const body = res.json() as { tokens: Array<Record<string, unknown>> };
      return body.tokens.map((t) => ({
        id: t.id as string,
        hint: t.hint as string,
        label: t.label as string | null,
        pack: t.pack === null ? null : actor.aliases.unalias(`@${t.scope as string}/${t.pack as string}`),
        scope: actor.aliases.unalias(t.scope as string),
        cidr: t.cidr as string[],
        expiresAt: new Date(t.expires_at as string),
        lastUsed: t.last_used_at === null ? null : new Date(t.last_used_at as string),
        status: t.status as TokenInfo["status"],
        revokedReason: t.revoked_reason as string | null,
      }));
    },
    async revoke(token) {
      const session = actor.session();
      const res = await actor.send({ method: "DELETE", path: `/api/tokens/${token.id}`, session, headers: await actor.formHeaders(session) });
      if (res.status !== 200) throw actor.refused(res, "tokens.revoke");
    },
  };
}

const ATTEMPTS: Record<TokenAttempt, (pack: string) => [string, string]> = {
  publish: (pack) => ["POST", `/api/publish/${pack}/1.0.1/upload-url`],
  yank: (pack) => ["POST", `/api/packs/${pack}/1.0.0/yank`],
  mintToken: () => ["POST", "/api/tokens"],
  setVisibility: (pack) => ["POST", `/api/packs/${pack}/visibility`],
  listSessions: () => ["GET", "/api/auth/sessions"],
  showAccount: () => ["GET", "/api/auth/session"],
  changeEmail: () => ["POST", "/api/auth/email"],
  approveStaged: () => ["POST", "/api/publish/runs/run-1/approve"],
};

export function createWorldTokens(driver: Driver, getAccountId: (user: User) => Promise<string>): WorldTokens {
  const send = (method: string, path: string, headers: Record<string, string>, json?: unknown) =>
    driver.http.request({
      surface: "web",
      method,
      path,
      headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  const from = (ip: string | undefined): Record<string, string> => (ip ? { "cf-connecting-ip": ip } : {});
  const bearer = (token: MintedToken | string): Record<string, string> => ({ authorization: `Bearer ${valueOf(token)}` });
  const refusal = (res: ApiResponse, what: string): Refusal => {
    const body = res.json() as { reason?: RefusalReason; message?: string; retry_after_s?: number };
    if (!body.reason) throw new InfrastructureError(`${what}: ${res.status} without a reason: ${res.text.slice(0, 120)}`);
    return new Refusal(body.reason, { ...(body.message === undefined ? {} : { message: body.message }), ...(body.retry_after_s === undefined ? {} : { retryAfterS: body.retry_after_s }) });
  };

  return {
    async leakReport(tokenOrPrefix, o = {}) {
      const res = await send("POST", "/api/tokens/leak", from(o.from), { token: tokenOrPrefix });
      if (res.status === 429) return refusal(res, "tokens.leakReport");
      if (res.status !== 202) throw new InfrastructureError(`tokens.leakReport answered ${res.status}: ${res.text.slice(0, 120)}`);
      return observe(res);
    },
    async canRead(token, pack, o = {}) {
      if (!driver.storage || !driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver cannot ask the token gate: it has no storage seam`);
      const now = await driver.fakes.clock.call<number>("now");
      const { db } = await driver.storage();
      const ports = { d1: d1Over(db), clock: { now: () => now } };
      const grant = await authenticateToken(ports, valueOf(token), o.from ?? DEFAULT_ADDRESS);
      if (!grant) return new Refusal("signed-out");
      const [scope, name] = pack.systemName.slice(1).split("/") as [string, string];
      return grantCovers(grant, { scope, pack: name }) ? "readable" : new NotFound();
    },
    async attempt(token, action, pack) {
      const [method, path] = ATTEMPTS[action](pack.systemName);
      const res = await send(method, path, bearer(token));
      return res.status >= 200 && res.status < 300 ? "allowed" : "refused";
    },
    async seedOwner(user, pack) {
      if (!driver.storage || !driver.capabilities.has("storage")) {
        throw new InfrastructureError(`the ${driver.kind} driver cannot seed scope owners: it has no storage seam`);
      }
      const { db } = await driver.storage();
      const scope = /^@([^/]+)\//.exec(pack.systemName)?.[1];
      if (!scope) throw new InfrastructureError(`not a pack name: ${pack.systemName}`);
      await db.batch([
        db
          .prepare("INSERT OR IGNORE INTO scope_members (scope_id, user_id, role, created_at) VALUES ((SELECT id FROM scopes WHERE name = ?), ?, 'owner', ?)")
          .bind(scope, await getAccountId(user), new Date().toISOString()),
      ]);
    },
  };
}
