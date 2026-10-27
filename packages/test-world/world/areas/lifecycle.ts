import { privateArchiveKey } from "@packserver/core/access";
import { drainLifecycleNotices } from "@packserver/core/publishing";
import type { Driver } from "../../drivers/driver";
import type { Aliases } from "../alias";
import { InfrastructureError } from "../errors";
import { lifecycleCall } from "../lifecycle-call";
import { NotFound } from "../outcomes";
import { callerOf } from "./users";
import { registryD1 } from "../proofs";
import type { Pack, Sensitive, User } from "../types";
import type { ReportsModule } from "./reports";
import type { UsersModule } from "./users";

const POLL_MS = 250;
const SETTLE_MS = 20_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DeleteOffer {
  version: string;
  status: string;
  deletable: boolean;
  why?: string;
}

export interface LifecycleView {
  deleted: boolean;
  versions: DeleteOffer[];
}

/** Withdrawing versions and deleting packs, as the owners' controls do, and what the registry did about it afterwards. */
export interface LifecycleModule {
  lifecycle: {
    /** Signed-in people with a role in the seeded pack's scope: an owner and a maintainer. */
    staff(pack: Pack): Promise<{ owner: User; maintainer: User }>;
    /** One recorded fetch of the version, as the fetch counts hold it. */
    recordFetch(pack: Pack, version: string): Promise<void>;
    /** What each version's delete affordance offers the person; `NotFound` for someone who may not see the pack's controls. */
    offer(pack: Pack, by: User): Promise<LifecycleView | NotFound>;
    deletePack(pack: Pack, o: { by: User } & Sensitive): Promise<void | NotFound>;
    restorePack(pack: Pack, o: { by: User } & Sensitive): Promise<void | NotFound>;
    /** The stargazer's choice to hear of withdrawn versions by mail. */
    digest(user: User, on: boolean): Promise<void>;
    /** Sends what yanks and deprecations owe, through the mail fake. */
    deliver(): Promise<{ sent: number }>;
    /** The object kinds still stored for the version in the public bucket. */
    objects(pack: Pack, version: string): Promise<string[]>;
    /** Whether the private pack's archive for the version is still stored. */
    archiveKept(pack: Pack, version: string): Promise<boolean>;
    /** The cache addresses the registry asked the CDN to drop, in the order asked. */
    purged(): string[];
    /** Waits until the registry has removed the version's stored objects and, for a public pack, purged them from the CDN. */
    removedFromStorage(pack: Pack, version: string): Promise<void>;
    /** Asks for the daily pass over the pack's scope at the fake clock's time; it purges what the soft-delete window no longer holds. */
    sweep(pack: Pack): Promise<void>;
  };
}

export function createLifecycle(driver: Driver, aliases: Aliases, people: UsersModule, reports: ReportsModule): LifecycleModule {
  const storage = () => {
    if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver has no storage access`);
    return driver.publishStorage;
  };
  const fakes = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fakes`);
    return driver.fakes;
  };
  const split = (pack: Pack) => {
    const [scope, name] = pack.systemName.slice(1).split("/") as [string, string];
    return { scope, name, system: pack.systemName };
  };
  const until = async (what: string, read: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + SETTLE_MS;
    while (!(await read())) {
      if (Date.now() > deadline) throw new InfrastructureError(`${what} did not happen within ${SETTLE_MS} ms`);
      await wait(POLL_MS);
    }
  };
  const purgedAt = async (pack: Pack, version: string): Promise<unknown> => {
    const { scope, name } = split(pack);
    const rows = await storage().sql(
      `select v.objects_purged_at from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id where s.name = ? and p.name = ? and v.version = ?`,
      [scope, name, version],
    );
    return rows[0]?.objects_purged_at;
  };

  return {
    lifecycle: {
      async staff(pack) {
        const owner = await people.users.create();
        await owner.signIn();
        const maintainer = await people.users.create();
        await maintainer.signIn();
        await reports.reports.seedRole(pack, owner, "owner");
        await reports.reports.seedRole(pack, maintainer, "maintainer");
        return { owner, maintainer };
      },
      async recordFetch(pack, version) {
        const { scope, name } = split(pack);
        const day = new Date(await fakes().clock.call<number>("now")).toISOString().slice(0, 10);
        await storage().sql(
          `insert into fetch_days (pack_id, version, day, kind, caller, weight)
             select p.id, ?, ?, 'public', 'scenario', 1 from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?`,
          [version, day, scope, name],
        );
      },
      async offer(pack, by) {
        const res = await callerOf(by).call({ method: "GET", path: `/api/packs/${pack.systemName}/lifecycle` });
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) throw new InfrastructureError(`lifecycle.offer: the site answered ${res.status}`);
        const body = res.json() as { deleted: boolean; versions: Array<{ version: string; status: string; delete: { deletable: boolean; why?: string } }> };
        return {
          deleted: body.deleted,
          versions: body.versions.map((v) => ({ version: v.version, status: v.status, deletable: v.delete.deletable, ...(v.delete.why === undefined ? {} : { why: v.delete.why }) })),
        };
      },
      async deletePack(pack, o) {
        const out = await lifecycleCall(o.by, "lifecycle.deletePack", "pack.delete", pack.systemName.slice(1), `/api/packs/${pack.systemName}/delete`, {}, o);
        if (out instanceof NotFound) return out;
      },
      async restorePack(pack, o) {
        const out = await lifecycleCall(o.by, "lifecycle.restorePack", "pack.restore", pack.systemName.slice(1), `/api/packs/${pack.systemName}/restore`, {}, o);
        if (out instanceof NotFound) return out;
      },
      async digest(user, on) {
        const res = await callerOf(user).call({ method: "PUT", path: "/api/account/star-digest", json: { on } });
        if (res.status !== 200) throw new InfrastructureError(`lifecycle.digest: the site answered ${res.status}`);
      },
      async deliver() {
        const at = await fakes().clock.call<number>("now");
        return drainLifecycleNotices({ d1: await registryD1(driver), clock: { now: () => at } }, { mail: fakes().ports.mail, siteOrigin: "https://registry.test" });
      },
      async objects(pack, version) {
        const prefix = `${pack.systemName}/${version}/`;
        return (await storage().packs.public.list(prefix)).map((key) => key.slice(prefix.length)).sort();
      },
      async archiveKept(pack, version) {
        const { scope, name } = split(pack);
        const rows = await storage().sql(
          `select v.id from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id where s.name = ? and p.name = ? and v.version = ?`,
          [scope, name, version],
        );
        if (!rows[0]) throw new InfrastructureError(`${pack.systemName}@${version} has no version row`);
        return (await storage().packs.private.head(privateArchiveKey(String(rows[0].id)))) !== null;
      },
      purged: () => fakes().cdn.purged().map((url) => aliases.unalias(url)),
      async removedFromStorage(pack, version) {
        await until(`${pack.systemName}@${version} leaving storage`, async () => (await purgedAt(pack, version)) !== null && (await purgedAt(pack, version)) !== undefined);
      },
      async sweep(pack) {
        await storage().reindex.send({ schema: 1, type: "scope.proof_changed", scope: split(pack).scope, change: "daily" });
      },
    },
  };
}
