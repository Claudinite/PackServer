import { addGrant, removeGrant } from "@packserver/core/access";
import { verifySigned, type RegistryKey } from "@packserver/core/index";
import { PrivateEntry } from "@packserver/schema";
import type { ApiResponse, Driver } from "../../drivers/driver";
import type { Aliases } from "../alias";
import { InfrastructureError } from "../errors";
import { NotFound, Refusal, type Observation } from "../outcomes";
import { seededRegistryKey } from "../packs";
import { callerOf } from "./users";
import { createWorldTokens, d1Over, type WorldTokens } from "../tokens";
import type { ActionsRepo, Pack, Sensitive, User } from "../types";

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

/** The access page's data as the owner of a pack reads it. */
export interface AccessView {
  readonly visibility: "public" | "private";
  readonly published: boolean;
  readonly you: "owner" | "maintainer";
  readonly grants: ReadonlyArray<{ accountId: string; privateReposOnly: boolean; addedBy: string | null; lastFetchAt: number | null }>;
  readonly fetches: readonly FetchRecordView[];
  readonly changes: ReadonlyArray<{ at: string; actor: string | null; action: "grant.changed" | "visibility.changed"; change: string; accountId: string | null }>;
}

/** What a visit to a pack's access page ends in. */
export type AccessPageVisit = { readonly kind: "page"; readonly text: string } | { readonly kind: "sign-in"; readonly next: string };

/** A pack's access page and the changes it makes, as one person uses them. */
export interface AccessManager {
  view(): Promise<AccessView | NotFound>;
  /** The page itself: its text, the way in for someone signed out, or the one not-found page. */
  page(): Promise<AccessPageVisit | NotFound>;
  allow(account: Pick<Account, "id" | "privateReposOnly">, o?: Sensitive): Promise<void | NotFound>;
  remove(account: Pick<Account, "id">, o?: Sensitive): Promise<void | NotFound>;
  /** Going public asks for `confirmed` as well as the assertion; going private needs only the assertion. */
  setVisibility(to: "public" | "private", o?: Sensitive & { confirmed?: boolean }): Promise<void | NotFound>;
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
  /** Gives the registry its signing key, so a reindex it is sent can run. */
  seedRegistryKeys(): Promise<void>;
  /** The pack's access page and what it changes, as `by` uses them. */
  manage(pack: Pack, by: User): AccessManager;
  /** The writes a signed-in person may try on a pack, each as the registry answers it. */
  attemptWrites(user: User, pack: Pack): Promise<Observation[]>;
}

export interface AccessModule {
  tokens: WorldTokens;
  access: AccessVerbs;
}

/** Above the range the World gives its people, so an allocated account never meets one of theirs. */
let nextAccountId = 6_000_000_000;

export const createAccess = (driver: Driver, aliases: Aliases): AccessModule => {
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

  const manage = (pack: Pack, by: User): AccessManager => {
    const [scope, name] = pack.systemName.split("/") as [string, string];
    const base = `/api/packs/${scope}/${name}`;
    const bound = pack.systemName.slice(1);
    const refused = (res: ApiResponse, what: string): Refusal => {
      let body: { reason?: Refusal["reason"]; message?: string };
      try {
        body = res.json() as typeof body;
      } catch {
        throw new InfrastructureError(`${what}: expected a refusal or success, got ${res.status} ${res.text.slice(0, 120)}`);
      }
      if (!body.reason) throw new InfrastructureError(`${what}: got ${res.status} without a reason: ${res.text.slice(0, 120)}`);
      return new Refusal(body.reason, body.message === undefined ? {} : { message: body.message });
    };
    const settle = (res: ApiResponse, what: string): void | NotFound => {
      if (res.status === 404) return new NotFound();
      if (res.status >= 200 && res.status < 300) return;
      throw refused(res, what);
    };
    return {
      async view() {
        const res = await callerOf(by).call({ method: "GET", path: `/api/access/${scope}/${name}` });
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) throw refused(res, "access.view");
        const b = res.json() as {
          visibility: AccessView["visibility"]; published: boolean; you: AccessView["you"];
          grants: Array<{ account_id: string; private_repos_only: boolean; added_by: string | null; last_fetch_at: number | null }>;
          fetches: Array<{ kind: FetchRecordView["kind"]; outcome: FetchRecordView["outcome"]; account_id: string | null; repository: string | null; at: number }>;
          changes: Array<{ at: string; actor: string | null; action: AccessView["changes"][number]["action"]; change: string; account_id: string | null }>;
        };
        return {
          visibility: b.visibility,
          published: b.published,
          you: b.you,
          grants: b.grants.map((g) => ({ accountId: g.account_id, privateReposOnly: g.private_repos_only, addedBy: g.added_by === null ? null : aliases.unalias(g.added_by), lastFetchAt: g.last_fetch_at })),
          fetches: b.fetches.map((f) => ({ kind: f.kind, outcome: f.outcome, accountId: f.account_id, repository: f.repository, at: f.at })),
          changes: b.changes.map((c) => ({ at: c.at, actor: c.actor === null ? null : aliases.unalias(c.actor), action: c.action, change: c.change, accountId: c.account_id })),
        };
      },
      async page() {
        const res = await callerOf(by).call({ method: "GET", path: `/packs/${scope}/${name}/access` });
        if (res.status === 404) return new NotFound();
        if (res.status === 303) {
          const next = new URL(res.headers.get("location") ?? "", "https://site.invalid").searchParams.get("next");
          if (next === null) throw new InfrastructureError(`access.page: redirected without a way back: ${res.headers.get("location")}`);
          return { kind: "sign-in", next };
        }
        if (res.status !== 200) throw new InfrastructureError(`access.page: ${res.status} ${res.text.slice(0, 120)}`);
        return { kind: "page", text: aliases.unalias(res.text) };
      },
      async allow(account, o) {
        const headers = await callerOf(by).assertionHeaders("grant.add", o, `${bound}:${account.id}:${account.privateReposOnly === false ? "any" : "private"}`);
        const json = { account_id: String(account.id), ...(account.privateReposOnly === undefined ? {} : { private_repos_only: account.privateReposOnly }) };
        return settle(await callerOf(by).call({ method: "POST", path: `${base}/grants`, json, headers }), "access.allow");
      },
      async remove(account, o) {
        const headers = await callerOf(by).assertionHeaders("grant.remove", o, `${bound}:${account.id}`);
        return settle(await callerOf(by).call({ method: "DELETE", path: `${base}/grants/${account.id}`, headers }), "access.remove");
      },
      async setVisibility(to, o = {}) {
        const headers = await callerOf(by).assertionHeaders("pack.visibility", o, bound);
        return settle(await callerOf(by).call({ method: "POST", path: `${base}/visibility`, json: { visibility: to, ...(o.confirmed ? { confirm: true } : {}) }, headers }), "access.setVisibility");
      },
    };
  };

  const access: AccessVerbs = {
    manage,
    async seedRegistryKeys() {
      const { db } = await driver.storage!();
      const now = driver.fakes ? await driver.fakes.clock.call<number>("now") : Date.now();
      const statement = db.prepare("insert into feature_flags (key, value, security, updated_at) values ('registry_keys', ?, 0, ?) on conflict (key) do update set value = excluded.value");
      await (statement.bind(JSON.stringify([await seededRegistryKey()]), new Date(now).toISOString()) as { run(): Promise<unknown> }).run();
    },
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
