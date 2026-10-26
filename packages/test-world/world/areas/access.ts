import { addGrant, removeGrant } from "@packserver/core/access";
import { verifySigned, type RegistryKey } from "@packserver/core/index";
import { PrivateEntry } from "@packserver/schema";
import type { Driver } from "../../drivers/driver";
import { InfrastructureError } from "../errors";
import { NotFound, Refusal, type Observation } from "../outcomes";
import { seededRegistryKey } from "../packs";
import { callerOf } from "./users";
import { createWorldTokens, d1Over, type WorldTokens } from "../tokens";
import type { Pack, User } from "../types";

/** A GitHub account on a pack's allowlist, by the id GitHub gave it. */
export interface Account {
  readonly id: number;
  readonly login?: string;
  /** An organisation account defaults to private repositories only. */
  readonly type?: "user" | "organization";
  readonly privateReposOnly?: boolean;
}

/** One read of a private pack as its owner sees it. */
export interface FetchRecordView {
  readonly kind: "index" | "download";
  readonly outcome: "served" | "denied";
  readonly accountId: string | null;
  readonly repository: string | null;
  readonly at: number;
}

export interface AccessGrantOpts {
  /** The person who makes the change, through the registry; absent seeds it directly, as the owner's page will one day. */
  by?: User;
}

/** The private-pack access verbs and the registry key. */
export interface AccessVerbs {
  /** The key the registry's documents are signed with, as `keys.json` lists it. */
  registryKey(): Promise<RegistryKey>;
  /** Whether a private entry verifies against the registry key, as cn checks it. */
  verifies(entry: unknown): Promise<boolean>;
  allowAccount(pack: Pack, account: Account, o?: AccessGrantOpts): Promise<void | Refusal | NotFound>;
  disallowAccount(pack: Pack, account: Pick<Account, "id">, o?: AccessGrantOpts): Promise<void | Refusal | NotFound>;
  /** Gives a person the data model's `member` role in the pack's scope, which the interface never names for a person. */
  seedMember(pack: Pack, user: User): Promise<void>;
  /** The pack's reads the registry logged, newest first. */
  fetches(pack: Pack): Promise<FetchRecordView[]>;
  /** The writes a signed-in person may try on a pack, each as the registry answers it. */
  attemptWrites(user: User, pack: Pack): Promise<Observation[]>;
}

const GRANTS = (pack: Pack) => `/api/packs/${pack.systemName}/grants`;

export interface AccessModule {
  tokens: WorldTokens;
  access: AccessVerbs;
}

export const createAccess = (driver: Driver): AccessModule => {
  const packId = async (pack: Pack): Promise<string> => {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver cannot seed grants: it has no storage seam`);
    const [scope, name] = pack.systemName.slice(1).split("/") as [string, string];
    const { db } = await driver.storage();
    const out = (await (db.prepare("SELECT p.id AS id FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ?").bind(scope, name) as { all(): Promise<{ results?: Array<{ id: string }> }> }).all()).results?.[0];
    if (!out) throw new InfrastructureError(`${pack.systemName} was not created in this scenario`);
    return out.id;
  };
  const answered = (res: { status: number; text: string }, what: string): Refusal | NotFound | undefined => {
    if (res.status === 404) return new NotFound();
    if (res.status === 403) return new Refusal("forbidden");
    if (res.status !== 200 && res.status !== 201) throw new InfrastructureError(`${what}: the registry answered ${res.status}: ${res.text.slice(0, 120)}`);
    return undefined;
  };

  const rows = async (statement: string, ...params: unknown[]): Promise<Array<Record<string, unknown>>> => {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver has no storage seam`);
    const { db } = await driver.storage();
    return (await (db.prepare(statement).bind(...params) as { all(): Promise<{ results?: Array<Record<string, unknown>> }> }).all()).results ?? [];
  };

  const access: AccessVerbs = {
    registryKey: seededRegistryKey,
    async verifies(entry) {
      const now = driver.fakes ? await driver.fakes.clock.call<number>("now") : Date.now();
      return (await verifySigned(PrivateEntry, entry, { keys: [await seededRegistryKey()], now: new Date(now) })).ok;
    },
    async allowAccount(pack, account, o = {}) {
      const type = account.type ?? "user";
      if (o.by) {
        const res = await callerOf(o.by).call({
          method: "POST",
          path: GRANTS(pack),
          json: { account_id: String(account.id), account_type: type, ...(account.privateReposOnly === undefined ? {} : { private_repos_only: account.privateReposOnly }) },
        });
        return answered(res, "access.allowAccount");
      }
      const { db } = await driver.storage!();
      const now = driver.fakes ? await driver.fakes.clock.call<number>("now") : Date.now();
      await addGrant(
        { d1: d1Over(db), clock: { now: () => now }, rng: { float: () => Math.random(), uuid: () => crypto.randomUUID(), bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) } },
        { packId: await packId(pack), accountId: String(account.id), accountType: type, by: null, ...(account.privateReposOnly === undefined ? {} : { privateReposOnly: account.privateReposOnly }) },
      );
    },
    async seedMember(pack, user) {
      const { db } = await driver.storage!();
      const scope = pack.systemName.slice(1).split("/")[0];
      const now = driver.fakes ? await driver.fakes.clock.call<number>("now") : Date.now();
      await db.batch([
        db
          .prepare("INSERT OR REPLACE INTO scope_members (scope_id, user_id, role, created_at) VALUES ((SELECT id FROM scopes WHERE name = ?), ?, 'member', ?)")
          .bind(scope, (await user.account.show()).id, new Date(now).toISOString()),
      ]);
    },
    async fetches(pack) {
      const id = await packId(pack);
      return (await rows("SELECT kind, outcome, account_id, repository, at FROM fetch_log WHERE pack_id = ? ORDER BY at DESC, id", id)).map((r) => ({
        kind: r.kind as FetchRecordView["kind"],
        outcome: r.outcome as FetchRecordView["outcome"],
        accountId: (r.account_id as string | null) ?? null,
        repository: (r.repository as string | null) ?? null,
        at: r.at as number,
      }));
    },
    async attemptWrites(user, pack) {
      const base = `/api/packs/${pack.systemName}`;
      const attempts: Array<[string, unknown]> = [
        [`${base}/star`, {}],
        [`${base}/reviews`, { rating: 5, text: "x" }],
        [`${base}/votes`, { section: "readme", vote: "up" }],
        [`${base}/reports`, { kind: "bug", title: "x", body: "x" }],
        [`${base}/access-requests`, { note: "x" }],
        [`/api/invitations/${"0".repeat(32)}/accept`, {}],
      ];
      const out: Observation[] = [];
      for (const [path, json] of attempts) {
        const res = await callerOf(user).call({ method: "POST", path, json });
        out.push({ status: res.status, headers: { "cache-control": res.headers.get("cache-control") ?? "" }, body: pack.systemName ? res.text.replaceAll(pack.systemName, "<pack>").replaceAll(pack.systemName.replace("/", "%2F"), "<pack>") : res.text });
      }
      return out;
    },
    async disallowAccount(pack, account, o = {}) {
      if (o.by) return answered(await callerOf(o.by).call({ method: "DELETE", path: `${GRANTS(pack)}/${account.id}` }), "access.disallowAccount");
      const { db } = await driver.storage!();
      await removeGrant({ d1: d1Over(db) }, await packId(pack), String(account.id));
    },
  };

  return { access, tokens: createWorldTokens(driver, async (user: User) => (await user.account.show()).id) };
};
