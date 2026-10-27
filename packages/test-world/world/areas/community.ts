import {
  drainCommunityNotices, refreshPack, hideReview, openReviewFlags, openStarHolds, recomputeCommunity, reviewStarHold,
  type CommunityPorts, type FlaggedReview, type StarHold,
} from "@packserver/core/community";
import type { D1 } from "@packserver/ports";
import type { ApiResponse, Driver, SeedStorage } from "../../drivers/driver";
import type { Aliases } from "../alias";
import { InfrastructureError, stubModule } from "../errors";
import { NotFound, Refusal, type Observation, type RefusalReason } from "../outcomes";
import type { PackHandle } from "../packs";
import type { Pack, User } from "../types";
import { createAgents } from "./agents";

export interface StarCount {
  /** Stars that count publicly. */
  count: number;
  /** Whether the viewer has starred, whether or not theirs counts. */
  starred: boolean;
}

export interface ReviewDraft {
  rating: number;
  body?: string;
  /** The version reviewed; the pack's first seeded version by default. */
  version?: string;
}

export interface ReviewInfo {
  id: string;
  rating: number;
  body: string;
  version: string;
  verified_adoption: boolean;
  author: string | null;
  reply: { body: string; at: string } | null;
  flagged?: boolean;
}

export interface ReviewList {
  /** The prior-weighted rating shown beside the pack; null until it has a review. */
  rating: number | null;
  reviewCount: number;
  verifiedCount: number;
  /** False when no version can be adopted. */
  available: boolean;
  reviews: ReviewInfo[];
  mine?: ReviewInfo | null;
}

export interface SeedStars {
  count: number;
  /** How old the made-up accounts are; two days by default. */
  accountAge?: string;
  /** The stars were placed evenly between these two points in the past; the last 24 hours by default. */
  between?: { from: string; to: string };
}

export interface SeedReviews {
  count: number;
  /** The mean of the ratings seeded, which must be reachable with whole ratings. */
  average: number;
  /** Marks them as verified-adoption reviews. */
  verified?: boolean;
  version?: string;
}

export interface Hold {
  pack: string;
  stars: number;
  dailyAverage: number;
  endsAt: Date;
}

export interface FlagInfo {
  reviewId: string;
  pack: string;
}

/** Stars, ratings and reviews acted as people, the moderators' side of them, and the seeding that stands in for other areas. */
export interface CommunityModule {
  community: {
    star(user: User, pack: Pack): Promise<StarCount | Refusal>;
    unstar(user: User, pack: Pack): Promise<StarCount>;
    /** What the pack shows; `viewer` sees their own star as placed. */
    stars(pack: Pack, viewer?: User): Promise<StarCount | NotFound>;
    /** Follows the pack page's star link as a visitor, or as the person when given. */
    clickStar(pack: Pack, user?: User): Promise<Observation>;
    /** Follows an address the site sent a person to, as that person. */
    follow(user: User, path: string): Promise<Observation>;
    review(user: User, pack: Pack, draft: ReviewDraft): Promise<ReviewInfo | Refusal>;
    reviews(pack: Pack, viewer?: User): Promise<ReviewList | NotFound>;
    reply(user: User, pack: Pack, review: { id: string }, body: string): Promise<ReviewInfo | Refusal | NotFound>;
    flag(user: User, pack: Pack, review: { id: string }): Promise<true | Refusal | NotFound>;
    /** The one thing a publisher is not offered. */
    delete(user: User, pack: Pack, review: { id: string }): Promise<Refusal>;
    /** Makes the account older (or younger) than it was made: it was created this long ago on the fake clock. */
    setAge(user: User, age: string): Promise<void>;
    /** The hourly job at the fake clock's time. */
    recompute(): Promise<{ mean: number; packs: number }>;
    /** Calls the MCP tool `get_download` signed in, through an OAuth grant the person approves. */
    download(user: User, pack: Pack): Promise<void>;
    /** Sends what is queued for people (a removed review's reason) through the mail fake. */
    deliver(): Promise<{ sent: number }>;
    moderation: {
      /** An admin takes a review down with a reason. */
      hide(review: { id: string }, reason: string): Promise<void>;
      /** Reviews publishers flagged and a moderator has not yet read. */
      flags(): Promise<FlagInfo[]>;
      /** Anomaly holds waiting for a moderator. */
      holds(): Promise<Hold[]>;
      /** The hold's moderator releases it (`release`) or leaves it to run its 7 days. */
      decide(pack: Pack, o: { release: boolean }): Promise<void>;
    };
    seed: {
      /** Made-up accounts that starred the pack, for the volume a burst needs. */
      stars(pack: Pack, o: SeedStars): Promise<void>;
      /** Made-up accounts that reviewed the pack. */
      reviews(pack: Pack, o: SeedReviews): Promise<void>;
      /** A later weekly scan completed and found no declaration at all, as when every repository dropped it. */
      laterScanFindsNone(): Promise<void>;
      /** The person stops being an owner or maintainer of the pack's scope, as an org removes a member. */
      leaveScope(pack: Pack, user: User): Promise<void>;
    };
  };
  reportAbuse(user: User, target: unknown, o: { category: string; details: string }): Promise<unknown>;
}

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 };
function durationMs(text: string): number {
  const parts = [...text.matchAll(/(\d+)([dhm])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== text) throw new InfrastructureError(`not a duration: ${text} (use e.g. 2d or 23h59m)`);
  return parts.reduce((sum, p) => sum + Number(p[1]) * UNIT_MS[p[2] as keyof typeof UNIT_MS], 0);
}

interface Bound {
  all(): Promise<{ results?: unknown[]; meta?: { changes?: number; last_row_id?: number } }>;
}

function d1Over(db: SeedStorage["db"]): D1 {
  const bind = (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params) as Bound;
  const shape = (r: Awaited<ReturnType<Bound["all"]>>) => ({
    rows: (r.results ?? []) as Array<Record<string, unknown>>,
    meta: { changes: r.meta?.changes ?? 0, last_row_id: r.meta?.last_row_id ?? null },
  });
  return {
    query: async (sql, params) => shape(await bind(sql, params).all()),
    batch: async (statements) => (await db.batch(statements.map((s) => bind(s.sql, s.params)))).map((r) => shape(r as never)),
  };
}

const PER_STATEMENT = 90;

export function createCommunity(driver: Driver, aliases: Aliases): CommunityModule {
  const storage = async () => {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver cannot read stored state`);
    return driver.storage();
  };
  const d1 = async (): Promise<D1> => d1Over((await storage()).db);
  const now = async (): Promise<number> => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no clock`);
    return driver.fakes.clock.call<number>("now");
  };
  const ports = async (): Promise<CommunityPorts> => {
    const at = await now();
    return { clock: { now: () => at }, rng: { uuid: () => crypto.randomUUID(), float: Math.random, bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) }, d1: await d1() };
  };
  const json = <T>(res: ApiResponse): T => JSON.parse(aliases.unalias(res.text)) as T;
  const refusalOf = (res: ApiResponse, what: string): Refusal => {
    let body: { reason?: RefusalReason; message?: string };
    try {
      body = res.json() as typeof body;
    } catch {
      throw new InfrastructureError(`${what}: ${res.status} ${res.text.slice(0, 120)}`);
    }
    if (!body.reason) throw new InfrastructureError(`${what}: ${res.status} without a reason: ${res.text.slice(0, 120)}`);
    return new Refusal(body.reason, body.message === undefined ? {} : { message: body.message });
  };
  const path = (pack: Pack) => `/api/packs/${pack.systemName}`;
  const userId = async (user: User) => (await user.account.show()).id;
  const packId = async (pack: Pack): Promise<string> => {
    const [scope, name] = pack.systemName.slice(1).split("/");
    const { rows } = await (await d1()).query("select p.id as id from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?", [scope, name]);
    if (!rows[0]) throw new InfrastructureError(`${pack.name} was not created in this scenario`);
    return String(rows[0].id);
  };
  const firstVersion = async (id: string): Promise<string> => {
    const { rows } = await (await d1()).query("select version from pack_versions where pack_id = ? order by published_at, version limit 1", [id]);
    if (!rows[0]) throw new InfrastructureError("the pack has no version to review");
    return String(rows[0].version);
  };
  const observe = (res: ApiResponse): Observation => ({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: res.text });
  const run = async (statements: Array<{ sql: string; params: unknown[] }>): Promise<void> => {
    const db = await d1();
    for (let i = 0; i < statements.length; i += 20) await db.batch(statements.slice(i, i + 20));
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  /** Made-up accounts: they exist for the community tables to point at and never sign in. */
  async function madeUpAccounts(n: number, createdAt: string): Promise<string[]> {
    const ids = Array.from({ length: n }, () => crypto.randomUUID());
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    for (let i = 0; i < ids.length; i += PER_STATEMENT / 2) {
      const chunk = ids.slice(i, i + PER_STATEMENT / 2);
      statements.push({ sql: `insert into users (id, created_at) values ${chunk.map(() => "(?, ?)").join(", ")}`, params: chunk.flatMap((id) => [id, createdAt]) });
    }
    await run(statements);
    return ids;
  }

  return {
    community: {
      async star(user, pack) {
        const res = await user.request("PUT", `${path(pack)}/star`);
        return res.status === 200 ? json<StarCount>(res) : refusalOf(res, "star");
      },
      async unstar(user, pack) {
        const res = await user.request("DELETE", `${path(pack)}/star`);
        if (res.status !== 200) throw refusalOf(res, "unstar");
        return json<StarCount>(res);
      },
      async stars(pack, viewer) {
        const res = viewer ? await viewer.request("GET", `${path(pack)}/stars`) : await driver.http.request({ surface: "web", method: "GET", path: `${path(pack)}/stars` });
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) throw new InfrastructureError(`stars: ${res.status} ${res.text.slice(0, 120)}`);
        return json<StarCount>(res);
      },
      async clickStar(pack, user) {
        const route = `/packs/${pack.systemName}/star`;
        return observe(user ? await user.request("GET", route) : await driver.http.request({ surface: "web", method: "GET", path: route }));
      },
      async follow(user, route) {
        return observe(await user.request("GET", route));
      },
      async review(user, pack, draft) {
        const id = await packId(pack);
        const res = await user.request("PUT", `${path(pack)}/review`, {
          json: { rating: draft.rating, body: draft.body ?? "", version: draft.version ?? (await firstVersion(id)) },
        });
        if (res.status !== 200 && res.status !== 201) return refusalOf(res, "review");
        return json<{ review: ReviewInfo }>(res).review;
      },
      async reviews(pack, viewer) {
        const res = viewer ? await viewer.request("GET", `${path(pack)}/reviews`) : await driver.http.request({ surface: "web", method: "GET", path: `${path(pack)}/reviews` });
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) throw new InfrastructureError(`reviews: ${res.status} ${res.text.slice(0, 120)}`);
        const body = json<{ rating: number | null; review_count: number; verified_count: number; available: boolean; reviews: ReviewInfo[]; mine?: ReviewInfo | null }>(res);
        return {
          rating: body.rating,
          reviewCount: body.review_count,
          verifiedCount: body.verified_count,
          available: body.available,
          reviews: body.reviews,
          ...(body.mine === undefined ? {} : { mine: body.mine }),
        };
      },
      async reply(user, pack, review, body) {
        const res = await user.request("POST", `${path(pack)}/reviews/${review.id}/reply`, { json: { body } });
        if (res.status === 404) return new NotFound();
        return res.status === 201 ? json<{ review: ReviewInfo }>(res).review : refusalOf(res, "reply");
      },
      async flag(user, pack, review) {
        const res = await user.request("POST", `${path(pack)}/reviews/${review.id}/flag`, { json: {} });
        if (res.status === 404) return new NotFound();
        return res.status === 200 ? true : refusalOf(res, "flag");
      },
      async delete(user, pack, review) {
        const res = await user.request("DELETE", `${path(pack)}/reviews/${review.id}`);
        if (res.status === 200 || res.status === 204) throw new InfrastructureError("a review was deleted");
        return refusalOf(res, "delete");
      },
      async setAge(user, age) {
        const at = await now();
        await run([{ sql: "update users set created_at = ? where id = ?", params: [iso(at - durationMs(age)), await userId(user)] }]);
      },
      recompute: async () => recomputeCommunity(await ports()),
      async download(user, pack) {
        const agent = await createAgents(driver, aliases).agents.oauth(user, { scopes: ["packs:read"] });
        const answer = await agent.download(pack as unknown as PackHandle);
        if (!answer.ok) throw new InfrastructureError(`get_download did not grant ${pack.systemName}: ${JSON.stringify(answer.body)}`);
      },
      async deliver() {
        if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no mail fake`);
        const result = await drainCommunityNotices(await ports(), { mail: driver.fakes.ports.mail, siteOrigin: "https://registry.test" });
        return { sent: result.sent };
      },
      moderation: {
        async hide(review, reason) {
          const result = await hideReview(await ports(), review.id, reason);
          if (!result.ok) throw new InfrastructureError(`the review was not hidden: ${result.reason}`);
        },
        async flags() {
          return (await openReviewFlags(await ports())).map((f: FlaggedReview) => ({ reviewId: f.review_id, pack: aliases.unalias(f.pack) }));
        },
        async holds() {
          return (await openStarHolds(await d1())).map((h: StarHold & { pack: string }) => ({
            pack: aliases.unalias(h.pack),
            stars: h.burst_stars,
            dailyAverage: h.daily_average,
            endsAt: new Date(h.ends_at),
          }));
        },
        async decide(pack, o) {
          const id = await packId(pack);
          const { rows } = await (await d1()).query("select id from star_holds where pack_id = ? and reviewed_at is null", [id]);
          if (!rows[0]) throw new InfrastructureError(`${pack.name} has no hold waiting`);
          await reviewStarHold(await ports(), String(rows[0].id), o);
        },
      },
      seed: {
        async laterScanFindsNone() {
          const at = iso((await now()) + 1000);
          await run([{ sql: "insert into adoption_scans (id, started_at, updated_at, completed_at) values (?, ?, ?, ?)", params: [crypto.randomUUID(), at, at, at] }]);
        },
        async leaveScope(pack, user) {
          const [scope] = pack.systemName.slice(1).split("/");
          await run([{ sql: "delete from scope_members where scope_id = (select id from scopes where name = ?) and user_id = ?", params: [scope, await userId(user)] }]);
        },
        async stars(pack, o) {
          const at = await now();
          const id = await packId(pack);
          const accounts = await madeUpAccounts(o.count, iso(at - durationMs(o.accountAge ?? "2d")));
          const from = at - durationMs(o.between?.from ?? "23h");
          const to = at - durationMs(o.between?.to ?? "1m");
          const rows = accounts.map((user, i) => [id, user, iso(from + Math.floor(((to - from) * i) / Math.max(1, o.count - 1)))]);
          const statements: Array<{ sql: string; params: unknown[] }> = [];
          for (let i = 0; i < rows.length; i += PER_STATEMENT / 3) {
            const chunk = rows.slice(i, i + PER_STATEMENT / 3);
            statements.push({ sql: `insert into stars (pack_id, user_id, created_at) values ${chunk.map(() => "(?, ?, ?)").join(", ")}`, params: chunk.flat() });
          }
          await run(statements);
          await refreshPack(await ports(), id);
        },
        async reviews(pack, o) {
          const at = await now();
          const id = await packId(pack);
          const version = o.version ?? (await firstVersion(id));
          const total = Math.round(o.count * o.average);
          if (Math.abs(total / o.count - o.average) > 1e-9) throw new InfrastructureError(`${o.average} is not a mean of ${o.count} whole ratings`);
          const base = Math.floor(total / o.count);
          const higher = total - base * o.count;
          if (base < 1 || base + (higher > 0 ? 1 : 0) > 5) throw new InfrastructureError(`ratings averaging ${o.average} are outside 1 to 5`);
          const accounts = await madeUpAccounts(o.count, iso(at - durationMs("3d")));
          const rows = accounts.map((user, i) => [crypto.randomUUID(), id, user, i < higher ? base + 1 : base, version, o.verified ? 1 : 0, iso(at)]);
          const statements: Array<{ sql: string; params: unknown[] }> = [];
          for (let i = 0; i < rows.length; i += 12) {
            const chunk = rows.slice(i, i + 12);
            statements.push({
              sql: `insert into reviews (id, pack_id, user_id, rating, body, version, verified_adoption, created_at, updated_at) values ${chunk.map(() => "(?, ?, ?, ?, '', ?, ?, ?, ?)").join(", ")}`,
              params: chunk.flatMap(([rid, pid, uid, rating, ver, verified, when]) => [rid, pid, uid, rating, ver, verified, when, when]),
            });
          }
          await run(statements);
          await refreshPack(await ports(), id);
        },
      },
    },
    reportAbuse: stubModule<Pick<CommunityModule, "reportAbuse">>("community").reportAbuse,
  };
}
