import { drainNotices, publishAdvisory, readReport, sweepReports, type Advisory, type AttachmentMeta, type ReportPorts, type ReportView } from "@packserver/core/reports";
import type { D1 } from "@packserver/ports";
import type { ApiResponse, Driver, SeedStorage } from "../../drivers/driver";
import type { Aliases } from "../alias";
import { InfrastructureError } from "../errors";
import { NotFound, Refusal, type RefusalReason } from "../outcomes";
import type { Pack, User } from "../types";

export type Role = "owner" | "admin" | "publisher" | "member";

export interface AttachmentDraft {
  name: string;
  /** Literal text content. */
  text?: string;
  /** Otherwise a file of this many bytes that looks like its name says and holds nothing else. */
  bytes?: number;
}

export interface ReportDraft {
  kind: "bug" | "security";
  version?: string;
  type?: "crash" | "wrong_behaviour" | "docs" | "compatibility" | "other";
  severity?: "low" | "medium" | "high" | "critical";
  title?: string;
  repro?: string;
  environment?: string;
  attachments?: AttachmentDraft[];
}

export interface FiledReport {
  readonly id: string;
  readonly kind: "bug" | "security";
  readonly route: ReportView["route"];
  readonly status: ReportView["status"];
  /** What the pre-filled GitHub issue the reporter opens themselves says; absent when the report went to the inbox. */
  readonly newIssue: { repository: string; title: string; body: string } | null;
  readonly attachments: readonly AttachmentMeta[];
  /** Security reports: when the disclosure timer ends. */
  readonly disclosureEnds: Date | null;
}

export type ReportInfo = ReportView;

export interface Inbox {
  reports: ReportInfo[];
  needsSecurityContact: boolean;
}

export interface QueuedNotice {
  kind: string;
  data: Record<string, unknown>;
}

export type StatusChange =
  | { status: "open" | "acknowledged" | "wont_fix" | "duplicate" }
  | { status: "fixed"; fixedIn: string };

export interface AdvisoryDraft {
  summary: string;
  versions: string[];
  fixedIn?: string;
  severity?: ReportDraft["severity"];
}

export const REGISTRY_SECURITY_ADDRESS = "security@registry.test";

/** Registry security acts through the shipped functions the admin Worker will call; it is not a signed-in person. */
export interface RegistrySecurity {
  read(report: { id: string }): Promise<ReportInfo | NotFound>;
  publishAdvisory(report: { id: string }, draft: AdvisoryDraft): Promise<Advisory>;
}

/** Bug and security reports, advisories, and the mail they cause. */
export interface ReportsModule {
  reports: {
    /** Gives a signed-in person a role in the pack's scope. */
    seedRole(pack: Pack, user: User, role: Role): Promise<void>;
    /** The owners' own setting; `null` removes it. */
    setSecurityContact(owner: User, pack: Pack, email: string | null): Promise<void>;
    file(user: User, pack: Pack, draft: ReportDraft): Promise<FiledReport>;
    /** The reporter says which GitHub issue they opened. */
    linkIssue(user: User, report: { id: string }, issue: { repository: string; number: number }): Promise<ReportInfo>;
    read(user: User | undefined, report: { id: string }): Promise<ReportInfo | NotFound>;
    /** The public Issues tab. */
    issues(pack: Pack, viewer?: User): Promise<ReportInfo[]>;
    inbox(user: User, pack: Pack): Promise<Inbox | NotFound>;
    mine(user: User): Promise<ReportInfo[]>;
    similar(user: User | undefined, pack: Pack, title: string): Promise<Array<{ title: string; status: string }>>;
    setStatus(user: User, report: { id: string }, change: StatusChange): Promise<ReportInfo | NotFound>;
    /** What a download of the attachment answers. */
    download(user: User | undefined, report: { id: string }, attachment: { id: string }): Promise<{ disposition: string; contentType: string; sniffable: boolean } | NotFound>;
    advisories(pack: Pack, version?: string): Promise<Advisory[]>;
    /** Runs the scheduled pass (reminders, expiry, stale uploads) at the current time. */
    sweep(pack?: Pack): Promise<{ reminded: number; expired: number; discarded: number }>;
    /** What is queued for a person, an address or registry security, and not yet sent. */
    queued(to: User | "registry-security" | { address: string }, about?: Pack): Promise<QueuedNotice[]>;
    /** Sends what is queued through the mail fake, so `world.mail` shows it. */
    deliver(): Promise<{ sent: number }>;
    readonly securityAddress: string;
    registrySecurity: RegistrySecurity;
  };
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function parseNewIssue(address: string): NonNullable<FiledReport["newIssue"]> {
  const url = new URL(address);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "github.com" || !url.pathname.endsWith("/issues/new")) throw new InfrastructureError(`not a new-issue address: ${address}`);
  return { repository: `${owner}/${repo}`, title: url.searchParams.get("title") ?? "", body: url.searchParams.get("body") ?? "" };
}

function synthesise(draft: AttachmentDraft): Uint8Array {
  if (draft.text !== undefined) return new TextEncoder().encode(draft.text);
  const out = new Uint8Array(draft.bytes ?? 1024);
  if (draft.name.toLowerCase().endsWith(".png")) out.set(PNG);
  else out.fill(0x2e);
  return out;
}

interface Bound {
  all(): Promise<{ results?: unknown[]; meta?: { changes?: number; last_row_id?: number } }>;
}

/** The registry database as the shipped functions see it, over the binding the Workers use. */
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

export function createReportsModule(driver: Driver, aliases: Aliases): ReportsModule {
  const storage = async () => {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver cannot read stored state`);
    return driver.storage();
  };
  const d1 = async (): Promise<D1> => d1Over((await storage()).db);
  const now = async (): Promise<number> => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no clock: reports cannot be swept on a deployment`);
    return driver.fakes.clock.call<number>("now");
  };
  /** The shipped functions, run against the registry's own database at the fake clock's time. */
  const ports = async (): Promise<ReportPorts> => {
    const at = await now();
    return { clock: { now: () => at }, rng: { uuid: () => crypto.randomUUID(), float: Math.random, bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) }, d1: await d1(), siteOrigin: "https://registry.test" };
  };

  const path = (pack: Pack) => `/api/packs/${pack.systemName}`;
  const json = <T>(res: ApiResponse): T => JSON.parse(aliases.unalias(res.text)) as T;
  const orRefusal = (res: ApiResponse, what: string): never => {
    let body: { reason?: RefusalReason; message?: string };
    try {
      body = res.json() as typeof body;
    } catch {
      throw new InfrastructureError(`${what}: ${res.status} ${res.text.slice(0, 120)}`);
    }
    if (!body.reason) throw new InfrastructureError(`${what}: ${res.status} without a reason: ${res.text.slice(0, 120)}`);
    throw new Refusal(body.reason, body.message === undefined ? {} : { message: body.message });
  };
  const anonymous = (method: string, route: string): Promise<ApiResponse> =>
    driver.http.request({ surface: "web", method, path: route });
  const as = (user: User | undefined, route: string): Promise<ApiResponse> => (user ? user.request("GET", route) : anonymous("GET", route));
  const info = (res: ApiResponse): ReportInfo => json<{ report: ReportInfo }>(res).report;
  const userId = async (user: User) => (await user.account.show()).id;
  const packId = async (pack: Pack): Promise<string> => {
    const [scope, name] = pack.systemName.slice(1).split("/");
    const { rows } = await (await d1()).query("select p.id as id from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?", [scope, name]);
    return String(rows[0]?.id);
  };

  const security: RegistrySecurity = {
    async read(report) {
      return (await readReport(await ports(), report.id, { kind: "registry-security" })) ?? new NotFound();
    },
    async publishAdvisory(report, draft) {
      const result = await publishAdvisory(await ports(), report.id, {
        summary: draft.summary,
        versions: draft.versions,
        ...(draft.fixedIn ? { fixed_in: draft.fixedIn } : {}),
        ...(draft.severity ? { severity: draft.severity } : {}),
      });
      if (!result.ok) throw new InfrastructureError(`the advisory was refused: ${result.reason} ${result.message ?? ""}`);
      return result.advisory;
    },
  };

  return {
    reports: {
      securityAddress: REGISTRY_SECURITY_ADDRESS,
      registrySecurity: security,
      async seedRole(pack, user, role) {
        const { db } = await storage();
        const id = await userId(user);
        const [scope] = pack.systemName.slice(1).split("/");
        await db.batch([
          db
            .prepare("INSERT OR REPLACE INTO scope_members (scope_id, user_id, role, created_at) VALUES ((SELECT id FROM scopes WHERE name = ?), ?, ?, ?)")
            .bind(scope, id, role, new Date(await now()).toISOString()),
        ]);
      },
      async setSecurityContact(owner, pack, email) {
        const res = await owner.request("PUT", `${path(pack)}/security-contact`, { json: { email } });
        if (res.status !== 200) orRefusal(res, "setSecurityContact");
      },
      async file(user, pack, draft) {
        const ids: string[] = [];
        for (const attachment of draft.attachments ?? []) {
          const res = await user.request("POST", `${path(pack)}/reports/attachments?name=${encodeURIComponent(attachment.name)}`, { body: synthesise(attachment) });
          if (res.status !== 201) orRefusal(res, `attach ${attachment.name}`);
          ids.push(json<{ attachment: { id: string } }>(res).attachment.id);
        }
        const body = {
          kind: draft.kind,
          version: draft.version ?? "1.0.0",
          ...(draft.kind === "bug" ? { type: draft.type ?? "crash" } : {}),
          severity: draft.severity ?? "medium",
          title: draft.title ?? "Something is wrong",
          repro: draft.repro ?? "Run it.",
          environment: draft.environment ?? "cn on Linux",
          attachment_ids: ids,
        };
        const res = await user.request("POST", `${path(pack)}/reports`, { json: body });
        if (res.status !== 201) orRefusal(res, "file");
        const filed = json<{ report: ReportView; new_issue_url: string | null }>(res);
        return {
          id: filed.report.id,
          kind: filed.report.kind,
          route: filed.report.route,
          status: filed.report.status,
          newIssue: filed.new_issue_url ? parseNewIssue(filed.new_issue_url) : null,
          attachments: filed.report.attachments,
          disclosureEnds: filed.report.disclosure ? new Date(filed.report.disclosure.deadline) : null,
        };
      },
      async linkIssue(user, report, issue) {
        const res = await user.request("POST", `/api/reports/${report.id}/issue`, { json: { issue_url: `https://github.com/${aliases.alias(issue.repository.split("/")[0]!)}/${issue.repository.split("/")[1]}/issues/${issue.number}` } });
        if (res.status !== 200) orRefusal(res, "linkIssue");
        return info(res);
      },
      async read(user, report) {
        const res = await as(user, `/api/reports/${report.id}`);
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) throw new InfrastructureError(`read: ${res.status} ${res.text.slice(0, 120)}`);
        return info(res);
      },
      async issues(pack, viewer) {
        const res = await as(viewer, `${path(pack)}/issues`);
        if (res.status !== 200) throw new InfrastructureError(`issues: ${res.status} ${res.text.slice(0, 120)}`);
        return json<{ issues: ReportInfo[] }>(res).issues;
      },
      async inbox(user, pack) {
        const res = await user.request("GET", `${path(pack)}/reports`);
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) throw new InfrastructureError(`inbox: ${res.status} ${res.text.slice(0, 120)}`);
        const body = json<{ reports: ReportInfo[]; needs_security_contact: boolean }>(res);
        return { reports: body.reports, needsSecurityContact: body.needs_security_contact };
      },
      async mine(user) {
        const res = await user.request("GET", "/api/account/reports");
        if (res.status !== 200) throw new InfrastructureError(`mine: ${res.status} ${res.text.slice(0, 120)}`);
        return json<{ reports: ReportInfo[] }>(res).reports;
      },
      async similar(user, pack, title) {
        const res = await as(user, `${path(pack)}/reports/similar?title=${encodeURIComponent(title)}`);
        if (res.status !== 200) throw new InfrastructureError(`similar: ${res.status} ${res.text.slice(0, 120)}`);
        return json<{ similar: Array<{ title: string; status: string }> }>(res).similar;
      },
      async setStatus(user, report, change) {
        const body = "fixedIn" in change ? { status: change.status, fixed_in: change.fixedIn } : { status: change.status };
        const res = await user.request("POST", `/api/reports/${report.id}/status`, { json: body });
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) orRefusal(res, "setStatus");
        return info(res);
      },
      async download(user, report, attachment) {
        const res = await as(user, `/api/reports/${report.id}/attachments/${attachment.id}`);
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) throw new InfrastructureError(`download: ${res.status} ${res.text.slice(0, 120)}`);
        return {
          disposition: (res.headers.get("content-disposition") ?? "").split(";")[0] ?? "",
          contentType: res.headers.get("content-type") ?? "",
          sniffable: res.headers.get("x-content-type-options") !== "nosniff",
        };
      },
      async advisories(pack, version) {
        const res = await anonymous("GET", `${path(pack)}/advisories${version ? `?version=${encodeURIComponent(version)}` : ""}`);
        if (res.status !== 200) throw new InfrastructureError(`advisories: ${res.status} ${res.text.slice(0, 120)}`);
        return json<{ advisories: Advisory[] }>(res).advisories;
      },
      async sweep(pack) {
        return sweepReports(await ports(), pack ? { packId: await packId(pack) } : {});
      },
      async queued(to, about) {
        const recipient = to === "registry-security" ? to : "address" in to ? `address:${to.address}` : `user:${await userId(to)}`;
        const { rows } = await (await d1()).query("select kind, data from report_notices where recipient = ? and sent_at is null order by rowid", [recipient]);
        return rows
          .map((r) => ({ kind: String(r.kind), data: JSON.parse(String(r.data)) as Record<string, unknown> }))
          .filter((n) => about === undefined || n.data.pack === about.systemName);
      },
      async deliver() {
        if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no mail fake`);
        const result = await drainNotices(await ports(), { mail: driver.fakes.ports.mail, siteOrigin: "https://registry.test", securityAddress: REGISTRY_SECURITY_ADDRESS });
        return { sent: result.sent };
      },
    },
  };
}

