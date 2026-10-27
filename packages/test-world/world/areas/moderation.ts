import { createAudit } from "@packserver/core/audit";
import { holdEligibility, overdueReports, type PrioritisedReport } from "@packserver/core/alerts";
import { declaredBy, fileAbuseReport, sweepDmca, type ModerationPorts } from "@packserver/core/moderation";
import type { D1, Queue } from "@packserver/ports";
import type { ApiResponse, Driver } from "../../drivers/driver";
import type { Aliases } from "../alias";
import { InfrastructureError } from "../errors";
import { NotFound, Refusal, type Observation, type RefusalReason } from "../outcomes";
import type { Org, Pack, Scope, User, Version } from "../types";
import { d1Over } from "./community";
import type { AdminModule } from "./admin";

export type AbuseCategory = "malware" | "prompt_injection" | "secrets_leak" | "impersonation" | "spam" | "ip_infringement" | "other";

export interface AbuseInfo {
  id: string;
  category: AbuseCategory;
  /** The report repeated one already filed on the target and counts as no independent report. */
  collapsed: boolean;
  /** A high-severity report on a pack: it labels the pack and starts the judge's hour. */
  prioritised: boolean;
}

export type AbuseTarget = Pack | { review: { id: string } } | { profile: Scope | Org };

export interface AbuseDraft {
  category: AbuseCategory;
  details: string;
  /** The version a pack report is about; the newest the pack offers by default. */
  version?: string;
}

export interface MassReports {
  count: number;
  category: AbuseCategory;
  details: string;
  /** How old the made-up accounts are. */
  accountAge: string;
  version?: string;
}

/** Abuse reports acted as people, what publishers do about moderation, and the seeding that stands in for time and crowds. */
export interface ModerationModule {
  /** A signed-in person reports a pack, a review or a profile. */
  reportAbuse(user: User, target: AbuseTarget, draft: AbuseDraft): Promise<AbuseInfo | Refusal | NotFound>;
  /** Follows the pack page's report link as a visitor, or as the person when given. */
  clickReportAbuse(pack: Pack, user?: User): Promise<Observation>;
  moderation: {
    /** A publisher appeals what moderation did to the version. */
    appeal(user: User, version: Version, note: string): Promise<true | Refusal | NotFound>;
    /** A publisher answers a copyright removal with a counter-notice. */
    counterNotice(user: User, version: Version, notice: string): Promise<true | Refusal | NotFound>;
    /** A maintainer flags the author of a report on the pack as a spammer. */
    flagReporter(user: User, pack: Pack, report: { id: string }): Promise<true | Refusal | NotFound>;
    /** The address of the page a publisher's notice sends them to for the version's latest action. */
    appealLink(version: Version): Promise<string>;
    /** The reason the registry holds for the version being out of reach, which is what the index and the page publish. */
    reason(version: Version): Promise<string | null>;
    /** Who an audit entry about the version names, oldest first, as `verb` and actor. */
    audit(version: Version): Promise<Array<{ verb: string; actor: string }>>;
    /** What the judge's takedown timer does at the fake clock's time: the versions it holds through the admin internal API. Given packs, only reports on them are considered, which keeps scenarios that share a registry apart. */
    judge: { fireTimer(...packs: Pack[]): Promise<string[]> };
    dmca: {
      /** Moves the fake clock forward by whole business days (Monday to Friday). */
      advanceBusinessDays(days: number): Promise<void>;
      /** The hourly pass at the fake clock's time. */
      sweep(): Promise<{ restored: number }>;
    };
    seed: {
      /** The person has had `count` of their reports dismissed by a moderator. */
      dismissed(user: User, count: number): Promise<void>;
      /** Reports the person filed on the pack's earlier versions, which a publisher can see in the inbox. */
      reportsFiled(user: User, pack: Pack, count: number): Promise<void>;
      /** Made-up accounts, each reporting the pack with the same words through the shipped filing code. */
      identicalReports(pack: Pack, o: MassReports): Promise<void>;
    };
  };
}

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 };
function durationMs(text: string): number {
  const parts = [...text.matchAll(/(\d+)([dhm])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== text) throw new InfrastructureError(`not a duration: ${text} (use e.g. 2d or 23h59m)`);
  return parts.reduce((sum, p) => sum + Number(p[1]) * UNIT_MS[p[2] as keyof typeof UNIT_MS], 0);
}

const SITE = "https://registry.test";
const DAY_MS = 86_400_000;

export function createModeration(driver: Driver, aliases: Aliases, admins: Pick<AdminModule["admins"], "internal">): ModerationModule {
  const storage = async () => {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver cannot read stored state`);
    return driver.storage();
  };
  const d1 = async (): Promise<D1> => d1Over((await storage()).db);
  const now = async (): Promise<number> => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no clock`);
    return driver.fakes.clock.call<number>("now");
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const userId = async (user: User) => (await user.account.show()).id;
  const packId = async (pack: Pack): Promise<string> => {
    const [scope, name] = pack.systemName.slice(1).split("/");
    const { rows } = await (await d1()).query("select p.id as id from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?", [scope, name]);
    if (!rows[0]) throw new InfrastructureError(`${pack.name} was not created in this scenario`);
    return String(rows[0].id);
  };
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
  const actionId = async (version: Version): Promise<string> => {
    const { rows } = await (await d1()).query(
      `select a.id from moderation_actions a join packs p on p.id = a.pack_id join scopes s on s.id = p.scope_id
       where '@' || s.name || '/' || p.name = ? and a.version = ? order by a.taken_at desc, a.rowid desc limit 1`,
      [version.pack.systemName, version.version],
    );
    if (!rows[0]) throw new InfrastructureError(`moderation took no action on ${version.pack.name}@${version.version}`);
    return String(rows[0].id);
  };
  const post = async (user: User, path: string, body: unknown, what: string): Promise<true | Refusal | NotFound> => {
    const res = await user.request("POST", path, { json: body });
    if (res.status === 404) return new NotFound();
    return res.status >= 200 && res.status < 300 ? true : refusalOf(res, what);
  };
  const run = async (statements: Array<{ sql: string; params: unknown[] }>): Promise<void> => {
    const db = await d1();
    for (let i = 0; i < statements.length; i += 20) await db.batch(statements.slice(i, i + 20));
  };

  const queue: Queue = {
    send: async (message) => driver.publishStorage?.reindex.send(message),
    sendBatch: async (messages) => {
      for (const message of messages) await driver.publishStorage?.reindex.send(message);
    },
  };
  const ports = async (): Promise<ModerationPorts> => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no mail fake`);
    const at = await now();
    const clock = { now: () => at };
    const rng = { uuid: () => crypto.randomUUID(), float: Math.random, bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) };
    const db = await d1();
    return { clock, rng, d1: db, mail: driver.fakes.ports.mail, reindex: queue, audit: createAudit({ clock, rng, queue: { send: async () => {}, sendBatch: async () => {} }, d1: db }, { ipKey: "" }), emit: () => {}, siteOrigin: SITE };
  };

  return {
    async reportAbuse(user, target, draft) {
      const body =
        "review" in target
          ? { kind: "review", target: target.review.id }
          : "profile" in target
            ? { kind: "profile", target: aliases.alias(target.profile.name) }
            : { kind: "pack", target: target.systemName, ...(draft.version === undefined ? {} : { version: draft.version }) };
      const res = await user.request("POST", "/api/abuse/reports", { json: { ...body, category: draft.category, details: draft.details } });
      if (res.status === 404) return new NotFound();
      if (res.status !== 201) return refusalOf(res, "reportAbuse");
      return (JSON.parse(aliases.unalias(res.text)) as { report: AbuseInfo }).report;
    },
    async clickReportAbuse(pack, user) {
      const route = `/packs/${pack.systemName}/report-abuse`;
      const res = user ? await user.request("GET", route) : await driver.http.request({ surface: "web", method: "GET", path: route });
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: res.text };
    },
    moderation: {
      async appeal(user, version, note) {
        return post(user, `/api/abuse/actions/${await actionId(version)}/appeal`, { note }, "appeal");
      },
      async counterNotice(user, version, notice) {
        return post(user, `/api/abuse/actions/${await actionId(version)}/counter-notice`, { notice }, "counterNotice");
      },
      async flagReporter(user, pack, report) {
        return post(user, `/api/packs/${pack.systemName}/reports/${report.id}/flag-reporter`, {}, "flagReporter");
      },
      async appealLink(version) {
        return `/appeals/${await actionId(version)}`;
      },
      async reason(version) {
        const { rows } = await (await d1()).query(
          `select v.status_reason as reason from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
           where '@' || s.name || '/' || p.name = ? and v.version = ?`,
          [version.pack.systemName, version.version],
        );
        if (!rows[0]) throw new InfrastructureError(`${version.pack.name}@${version.version} is not in the registry`);
        return rows[0].reason === null ? null : String(rows[0].reason);
      },
      async audit(version) {
        const { rows } = await (await d1()).query("select detail, actor_id from recent_activity where target = ? and action = 'admin.action' order by at, id", [`version:${version.pack.systemName}@${version.version}`]);
        return rows.map((r) => ({ verb: (JSON.parse(String(r.detail)) as { verb: string }).verb, actor: aliases.unalias(String(r.actor_id)) }));
      },
      judge: {
        async fireTimer(...packs) {
          const db = await d1();
          const at = await now();
          const { rows } = await db.query(
            `select r.id, r.version, r.prioritised_at, '@' || s.name || '/' || p.name as pack
             from abuse_reports r join packs p on p.id = r.pack_id join scopes s on s.id = p.scope_id
             where r.state = 'open' and r.prioritised_at is not null and r.collapsed_into is null`,
          );
          const reports: PrioritisedReport[] = rows.map((r) => ({ id: String(r.id), pack: String(r.pack), version: String(r.version), at: Date.parse(String(r.prioritised_at)) }));
          const held = new Set<string>();
          for (const r of reports) {
            const taken = await db.query(
              "select 1 from moderation_actions a join packs p on p.id = a.pack_id join scopes s on s.id = p.scope_id where '@' || s.name || '/' || p.name = ? and a.version = ? and a.restored_at is null limit 1",
              [r.pack, r.version],
            );
            if (taken.rows.length > 0) held.add(r.id);
          }
          const out: string[] = [];
          const only = new Set(packs.map((p) => p.systemName));
          for (const report of overdueReports(reports, new Set(), held, at)) {
            if (only.size > 0 && !only.has(report.pack)) continue;
            if (holdEligibility(await declaredBy(db, report.pack)) !== "eligible") continue;
            const answer = await admins.internal("judge", { method: "quarantine_version", pack: report.pack, version: report.version, reason: "security report undecided for an hour" });
            if (!answer.ok) throw new InfrastructureError(`the judge's hold was refused: ${answer.reason}`);
            out.push(`${aliases.unalias(report.pack)}@${report.version}`);
          }
          return out;
        },
      },
      dmca: {
        async advanceBusinessDays(days) {
          if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no clock`);
          for (let counted = 0; counted < days; ) {
            await driver.fakes.clock.call("advance", { by: "1d" });
            const dow = new Date(await now()).getUTCDay();
            if (dow !== 0 && dow !== 6) counted += 1;
          }
        },
        async sweep() {
          return sweepDmca(await ports());
        },
      },
      seed: {
        async dismissed(user, count) {
          const id = await userId(user);
          const target = crypto.randomUUID();
          const at = iso((await now()) - DAY_MS);
          await run(
            Array.from({ length: count }, (_, i) => ({
              sql: `insert into abuse_reports (id, target_kind, target_id, reporter_id, category, details, details_key, state, decided_by, decided_at, created_at)
                    values (?, 'profile', ?, ?, 'spam', 'dismissed', ?, 'dismissed', 'seed', ?, ?)`,
              params: [crypto.randomUUID(), target, id, `seed-${i}`, at, at],
            })),
          );
        },
        async reportsFiled(user, pack, count) {
          const id = await userId(user);
          const pid = await packId(pack);
          const version = (await (await d1()).query("select version from pack_versions where pack_id = ? order by published_at limit 1", [pid])).rows[0]?.version;
          if (!version) throw new InfrastructureError("the pack has no version to report on");
          const at = iso(await now());
          await run(
            Array.from({ length: count }, (_, i) => ({
              sql: `insert into reports (id, pack_id, reporter_id, kind, version, type, severity, title, repro, environment, route, created_at, updated_at)
                    values (?, ?, ?, 'bug', ?, 'other', 'low', ?, 'x', 'x', 'inbox', ?, ?)`,
              params: [crypto.randomUUID(), pid, id, version, `Seeded report ${i}`, at, at],
            })),
          );
        },
        async identicalReports(pack, o) {
          const db = await d1();
          const at = await now();
          const born = iso(at - durationMs(o.accountAge));
          const ids = Array.from({ length: o.count }, () => crypto.randomUUID());
          await run(ids.map((id) => ({ sql: "insert into users (id, created_at) values (?, ?)", params: [id, born] })));
          const p = await ports();
          for (const id of ids) {
            const filed = await fileAbuseReport(p, id, { kind: "pack", target: pack.systemName, category: o.category, details: o.details, ...(o.version === undefined ? {} : { version: o.version }) });
            if (!filed.ok) throw new InfrastructureError(`a made-up account's report was refused: ${filed.reason}`);
          }
          void db;
        },
      },
    },
  };
}
