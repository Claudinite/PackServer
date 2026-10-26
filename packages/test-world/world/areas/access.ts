import { addGrant, removeGrant } from "@packserver/core/access";
import { verifySigned, type RegistryKey } from "@packserver/core/index";
import { PrivateEntry } from "@packserver/schema";
import type { Driver } from "../../drivers/driver";
import { InfrastructureError } from "../errors";
import type { Observation } from "../outcomes";
import { seededRegistryKey } from "../packs";
import { callerOf } from "./users";
import { createWorldTokens, d1Over, type WorldTokens } from "../tokens";
import type { ActionsRepo, Pack, User } from "../types";

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

/** The private-pack access verbs and the registry key. */
export interface AccessVerbs {
  /** A GitHub account with an id the World allocated, so no two scenarios share one. */
  account(login: string, o?: Pick<Account, "type" | "privateReposOnly">): Account;
  /** A repository of an account, as a workflow in it identifies itself. */
  repository(account: Account, name: string, visibility?: ActionsRepo["visibility"]): ActionsRepo;
  /** The key the registry's documents are signed with, as `keys.json` lists it. */
  registryKey(): Promise<RegistryKey>;
  /** Whether a private entry verifies against the registry key, as cn checks it. */
  verifies(entry: unknown): Promise<boolean>;
  /** Seeds a grant directly; the owner's access page will make the change through the registry. */
  allowAccount(pack: Pack, account: Account): Promise<void>;
  disallowAccount(pack: Pack, account: Pick<Account, "id">): Promise<void>;
  /** The pack's reads the registry logged, newest first. */
  fetches(pack: Pack): Promise<FetchRecordView[]>;
  /** The writes a signed-in person may try on a pack, each as the registry answers it. */
  attemptWrites(user: User, pack: Pack): Promise<Observation[]>;
}

export interface AccessModule {
  tokens: WorldTokens;
  access: AccessVerbs;
}

/** Above the range the World gives its people, so an allocated account never meets one of theirs. */
let nextAccountId = 6_000_000_000;

export const createAccess = (driver: Driver): AccessModule => {
  const packId = async (pack: Pack): Promise<string> => {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver cannot seed grants: it has no storage seam`);
    const [scope, name] = pack.systemName.slice(1).split("/") as [string, string];
    const { db } = await driver.storage();
    const out = (await (db.prepare("SELECT p.id AS id FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ?").bind(scope, name) as { all(): Promise<{ results?: Array<{ id: string }> }> }).all()).results?.[0];
    if (!out) throw new InfrastructureError(`${pack.systemName} was not created in this scenario`);
    return out.id;
  };
  const rows = async (statement: string, ...params: unknown[]): Promise<Array<Record<string, unknown>>> => {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver has no storage seam`);
    const { db } = await driver.storage();
    return (await (db.prepare(statement).bind(...params) as { all(): Promise<{ results?: Array<Record<string, unknown>> }> }).all()).results ?? [];
  };

  const access: AccessVerbs = {
    account: (login, o = {}) => ({ id: nextAccountId++, login, ...o }),
    repository: (account, name, visibility = "private") => ({ ownerId: account.id, repository: `${account.login}/${name}`, visibility }),
    registryKey: seededRegistryKey,
    async verifies(entry) {
      const now = driver.fakes ? await driver.fakes.clock.call<number>("now") : Date.now();
      return (await verifySigned(PrivateEntry, entry, { keys: [await seededRegistryKey()], now: new Date(now) })).ok;
    },
    async allowAccount(pack, account) {
      const type = account.type ?? "user";
      const { db } = await driver.storage!();
      const now = driver.fakes ? await driver.fakes.clock.call<number>("now") : Date.now();
      await addGrant(
        { d1: d1Over(db), clock: { now: () => now }, rng: { float: () => Math.random(), uuid: () => crypto.randomUUID(), bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) } },
        { packId: await packId(pack), accountId: String(account.id), accountType: type, by: null, ...(account.privateReposOnly === undefined ? {} : { privateReposOnly: account.privateReposOnly }) },
      );
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
    async disallowAccount(pack, account) {
      const { db } = await driver.storage!();
      await removeGrant({ d1: d1Over(db) }, await packId(pack), String(account.id));
    },
  };

  return { access, tokens: createWorldTokens(driver, async (user: User) => (await user.account.show()).id) };
};
