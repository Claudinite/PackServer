import type { ApiResponse, Driver } from "../drivers/driver";
import type { Aliases } from "./alias";
import { InfrastructureError } from "./errors";
import { Refusal, type Observation } from "./outcomes";
import type { Assertion, Pack, Session, Sensitive, User } from "./types";

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
  method?: string;
  path?: string;
}

/** Tokens as seen from outside any account: CI that holds one, and a visitor who found one. */
export interface WorldTokens {
  /** The public leak-report form. A token, a prefix of one, or any text. */
  leakReport(tokenOrPrefix: string, o?: { from?: string }): Promise<Observation>;
  /** Asks whether the token reads a pack: the token's own gate, which CI calls before it relies on one. */
  canRead(token: MintedToken | string, pack: Pack, o?: UseOpts): Promise<Observation>;
  /** Any call carrying the token as its only credential. */
  call(token: MintedToken | string, method: string, path: string, o?: Pick<UseOpts, "from">): Promise<Observation>;
  /** Makes the person an owner of the pack's scope, standing in for the scope verbs that arrive with the scopes area. */
  seedOwner(user: User, pack: Pack): Promise<void>;
}

/** What the person's own verbs need from the account that owns them. */
export interface TokenActor {
  send(req: { method: string; path: string; session?: Session | undefined; json?: unknown; headers?: Record<string, string> }): Promise<ApiResponse>;
  formHeaders(session: Session | undefined): Promise<Record<string, string>>;
  session(): Session | undefined;
  refused(res: ApiResponse, what: string): Refusal;
  aliases: Aliases;
}

const valueOf = (token: MintedToken | string): string => (typeof token === "string" ? token : token.value);

const observe = (res: ApiResponse): Observation => ({
  status: res.status,
  headers: Object.fromEntries([...res.headers].filter(([name]) => name !== "date" && name !== "set-cookie")),
  body: res.text,
});

function assertionHeader(assertion: Sensitive["assertion"]): Record<string, string> {
  if (assertion === "none") return {};
  if (assertion === "replay") return { "x-assertion-stub": "replayed" };
  const action = (assertion as Assertion | undefined)?.action ?? MINT_ACTION;
  return { "x-assertion-stub": action };
}

export function createUserTokens(actor: TokenActor): UserTokens {
  return {
    async mint(opts) {
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
        headers: { ...(await actor.formHeaders(session)), ...assertionHeader(opts.assertion) },
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

  return {
    async leakReport(tokenOrPrefix, o = {}) {
      return observe(await send("POST", "/api/tokens/leak", from(o.from), { token: tokenOrPrefix }));
    },
    async canRead(token, pack, o = {}) {
      return observe(await send("GET", `/api/tokens/check/${pack.systemName}`, { ...bearer(token), ...from(o.from) }));
    },
    async call(token, method, path, o = {}) {
      return observe(await send(method, path, { ...bearer(token), ...from(o.from) }));
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
