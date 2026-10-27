import { isContractMigration } from "@packserver/core/selftest";
import { SCHEMA_MAX, SCHEMA_MIN } from "@packserver/schema/range";
import type { Driver, StorageAccess } from "../../drivers/driver";
import type { Aliases } from "../alias";
import { InfrastructureError, stubModule } from "../errors";
import { Refusal } from "../outcomes";
import { createCron, type CronJob } from "../proofs";
import type { Admin, Notification, Version } from "../types";
import { AdmittedVersion } from "../publishing";

export type { CronJob };

export interface MigrationHeadOptions {
  /** What the migration past the compiled range is: an expand (the default) or a contract, which an older build cannot serve. */
  kind?: "expand" | "contract";
}

/** What the admin Worker's `env.test` admits; its drift guard keeps the two equal. */
export const ADMIN_EMAIL = "admin@example.test";
const ADMIN_SUB = "admin-1";
const SITE = "admin.internal";

export type AssertionKind = "valid" | "forged" | "wrong-audience" | "expired" | "outsider" | "missing";
export type VisitHow = AssertionKind | "workers-dev" | "preview-url";

export interface QueueEntry {
  kind: "report" | "held-version" | "appeal" | "application";
  /** `@scope/name`, for a version, an appeal or a report. */
  pack?: string;
  version?: string;
  scope?: string;
  id?: string;
  severity?: string;
  priority?: boolean;
  standing?: { verified: boolean; declaredBy: number | null };
}

export interface HeldItem {
  pack: string;
  version: string;
  /** The previous promoted version the diff is against. */
  against: string | null;
  files: Array<{ path: string; change: "added" | "removed" | "modified"; addedLines: number; removedLines: number; patch?: string[] }>;
  capabilities: { added: string[]; removed: string[]; widening: boolean };
  findings: Array<{ rule: string; class: string; file: string | null; line: number | null; quote: string | null; hint: string }>;
  proseScreen: { implementation: string; questionSetVersion: string; modelVersion: string | null; tripped: Array<{ chunk: string; question: string }> } | null;
  appeal: { note: string; state: "open" | "upheld" | "denied" } | null;
}

export interface FullReport {
  verdict: string;
  rulesVersion: string;
  score: number | null;
  findings: HeldItem["findings"];
  proseScreen: HeldItem["proseScreen"];
  /** The report exactly as the admin app returned it, for scans. */
  text: string;
}

export interface RecordedDecision {
  decision: "approve" | "reject" | "quarantine_publisher";
  reason: string | null;
  decidedBy: string;
  /** Whether a waiting workflow instance took the event; the decision stands either way. */
  delivered: boolean;
}

export interface AdminAuditEntry {
  action: string;
  target: string | null;
  verb: string | null;
  actor: string;
}

export type InternalCaller = "judge" | "admin_app";

export interface InternalAnswer {
  ok: boolean;
  /** The refusal's reason, or the method's, when the call did not succeed. */
  reason: string | null;
  auditId: string | null;
}

export interface OpsView {
  killSwitch: boolean;
  indexFrozen: boolean;
  telemetryMode: string;
  rollbackAvailable: boolean;
  flags: Array<{ key: string; value: unknown; source: string; security: boolean }>;
  blockedSources: Array<{ source: string; reason: string }>;
  acknowledged: string[];
  recent: Array<{ actor: string; verb: string; target: string | null }>;
}

export interface DisputeView {
  id: string;
  scope: string;
  claimant: string;
  domain: string;
  held: boolean;
  holderConsented: boolean;
  noticeAttached: boolean;
}

export type DisputeDecision = { kind: "reassign"; holderName?: string } | { kind: "keep" } | { kind: "notice" };

/** One signed-in admin of the admin app. */
export interface AdminSession extends Admin {
  readonly email: string;
  queue: {
    list(): Promise<QueueEntry[]>;
    open(version: Version): Promise<HeldItem>;
    approve(version: Version): Promise<void>;
    reject(version: Version, reason: string): Promise<void>;
    quarantinePublisher(version: Version, reason?: string): Promise<void>;
    /** The decision the registry database holds for the version, or null. */
    decision(version: Version): Promise<RecordedDecision | null>;
    dismissReport(report: { id: string }): Promise<void>;
  };
  applications: {
    list(): Promise<Array<{ scope: string; basis: string | null }>>;
    approve(org: { name: string }): Promise<void>;
    deny(org: { name: string }, reason: string): Promise<void>;
    revoke(org: { name: string }, reason?: string): Promise<void>;
    /** Grants with no application. */
    grant(scope: { name: string }): Promise<void>;
  };
  appeals: {
    list(): Promise<Array<{ pack: string; version: string; note: string }>>;
    uphold(version: Version): Promise<void>;
    deny(version: Version): Promise<void>;
  };
  reports: {
    full(version: Version): Promise<FullReport>;
    proseScreen(version: Version): Promise<HeldItem["proseScreen"]>;
    security(report: { id: string }): Promise<{ id: string; severity: string; title: string }>;
  };
  /** What the audit record holds under this admin, oldest first. */
  audit(): Promise<AdminAuditEntry[]>;
  ops: {
    state(): Promise<OpsView>;
    /** What the page is served as: found, under a nonce-based script policy, and with no inline handler or script URL. */
    page(): Promise<{ served: boolean; noncePolicy: boolean; inlineHandlers: boolean }>;
    /** A tap on the ops page: the same request the internal API takes, as the signed-in admin. */
    tap(request: Record<string, unknown>): Promise<InternalAnswer>;
  };
  flags: {
    set(key: string, value: unknown): Promise<void>;
  };
  revoke(version: Version, o: { reason: string; security: string }): Promise<void>;
  disputes: {
    list(): Promise<DisputeView[]>;
    resolve(scope: { name: string }, decision: DisputeDecision): Promise<void>;
  };
  holds: {
    list(): Promise<string[]>;
    clear(scope: { name: string }): Promise<void>;
  };
}

/** The admin host, scheduled jobs and the registry's own state. */
export interface AdminModule {
  admins: {
    create(): Promise<AdminSession>;
    notifications(): Promise<Notification[]>;
    /** Calls the admin app the way a stranger or a misconfigured client would; true when the app answered as something that exists. */
    visit(how: VisitHow): Promise<{ found: boolean }>;
    /** Records a domain proof on a scope without the DNS exchange, which a personal scope has no way to run. */
    proveDomain(scope: { name: string }, domain: string): Promise<void>;
    /** Makes the version the newest promoted one of its pack, in the way promotion will once it lands. */
    promoted(version: Version): Promise<void>;
    /** Records that the latest completed weekly scan found `repositories` public repositories declaring the pack. */
    declaredBy(pack: { systemName: string }, repositories: number): Promise<void>;
    /** Makes the version's pack private, in the way the publisher's visibility setting will once publishing can set it. */
    makePrivate(version: Version): Promise<void>;
    /** The publisher's appeal against a rejection, in the way the publish Worker will record it once it lands. */
    appeal(version: Version, note: string): Promise<void>;
    /** Holds the scope's publishing, in the way a handle near a later-verified scope is held at sign-up. */
    holdHandle(scope: { name: string }): Promise<void>;
    /** Calls the admin internal API as a service binding does: the judge or the admin app, with or without the admin's Access assertion. */
    internal(caller: InternalCaller, request: Record<string, unknown>, o?: { assertion?: AssertionKind }): Promise<InternalAnswer>;
    /** The roll-back workflow dispatches GitHub received. */
    rollbackDispatches(): Array<{ workflow: string; ref: string; reason: string | null; authorised: boolean }>;
    /** What the `flags/launch` key of the telemetry store holds, or null. */
    launchMirror(): Promise<string | null>;
  };
  cron: { run(job: CronJob): Promise<void> };
  /** Moves the registry's applied migration head to `n` (a migration timestamp) until the scenario ends (REQ-OPS-011). */
  database: {
    setMigrationHead(n: number, o?: MigrationHeadOptions): Promise<void>;
    /** The migration timestamps the Workers under test were built to serve. */
    supportedRange(): { min: number; max: number };
  };
  /** A digest of the registry database and the staging bucket, the `@packserver-canary` objects left out (REQ-OPS-008). */
  storage: { fingerprint(): Promise<string> };
  staging: { objects(): Promise<string[]> };
}

const CANARY = "@packserver-canary";
const MIGRATIONS = "d1_migrations";
const PLACEHOLDER = "world";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

const stores = (driver: Driver): StorageAccess => {
  if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver cannot read the registry's stored state`);
  return driver.publishStorage;
};

const ACCESS_HEADER = "cf-access-jwt-assertion";

export function createAdmin(driver: Driver, onDispose: (undo: () => Promise<void>) => void, aliases: Aliases): AdminModule {
  const fakes = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fake Access: an admin cannot be signed in`);
    return driver.fakes;
  };
  const nowMs = async () => Number(await fakes().clock.call<number>("now"));

  async function assertion(kind: AssertionKind): Promise<string | null> {
    if (kind === "missing") return null;
    const access = fakes().workers.access;
    if (!access) throw new InfrastructureError("the fake Access Worker is not booted");
    const email = kind === "outsider" ? "mallory@example.test" : ADMIN_EMAIL;
    const made = await access.call<string>("assert", {
      email,
      sub: ADMIN_SUB,
      ...(kind === "wrong-audience" ? { aud: ["another-application"] } : {}),
      ...(kind === "expired" ? { exp: Math.floor((await nowMs()) / 1000) - 60 } : {}),
    });
    return kind === "forged" ? made.replace(email, "root@example.test") : made;
  }

  async function call(method: string, path: string, o: { body?: unknown; as?: AssertionKind; host?: string; headers?: Record<string, string> } = {}) {
    const token = await assertion(o.as ?? "valid");
    return driver.http.request({
      surface: "admin",
      method,
      path,
      host: o.host ?? SITE,
      headers: { ...(token ? { [ACCESS_HEADER]: token } : {}), ...o.headers },
      ...(o.body === undefined ? {} : { body: o.body }),
    });
  }

  const refuse = (what: string, res: { status: number; text: string }): never => {
    let message = res.text.slice(0, 200);
    try {
      const body = JSON.parse(res.text) as { message?: string; reason?: string };
      message = aliases.unalias(body.message ?? body.reason ?? message);
    } catch {
      // Not JSON: the raw text is the message.
    }
    throw new Refusal("forbidden", { message: `${what}: ${message}` });
  };

  async function json<T>(what: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await call(method, path, body === undefined ? {} : { body });
    if (res.status >= 400) return refuse(what, res);
    return JSON.parse(aliases.unalias(res.text)) as T;
  }

  const sqlOf = () => {
    if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver cannot read the registry's stored state`);
    return driver.publishStorage.sql;
  };
  const runIdOf = (version: Version): string => {
    if (!(version instanceof AdmittedVersion)) throw new InfrastructureError("the admin app needs a version a publish returned");
    return version.run.id;
  };
  const iso = async () => new Date(await nowMs()).toISOString();

  const heldOf = (raw: Record<string, unknown>): HeldItem => {
    const report = raw.report as { pack: string; version: string; findings: HeldItem["findings"]; prose_screen: Record<string, unknown> | null } | null;
    const diff = raw.diff as { files: Array<{ path: string; change: "added" | "removed" | "modified"; added_lines: number; removed_lines: number; patch?: string[] }> } | null;
    const appeal = raw.appeal as { note: string; state: "open" | "upheld" | "denied" } | null;
    return {
      pack: report?.pack ?? "",
      version: report?.version ?? "",
      against: (raw.against as { version: string } | null)?.version ?? null,
      files: (diff?.files ?? []).map((f) => ({ path: f.path, change: f.change, addedLines: f.added_lines, removedLines: f.removed_lines, ...(f.patch ? { patch: f.patch } : {}) })),
      capabilities: raw.capabilities as HeldItem["capabilities"],
      findings: report?.findings ?? [],
      proseScreen: proseOf(report?.prose_screen ?? null),
      appeal: appeal ? { note: appeal.note, state: appeal.state } : null,
    };
  };
  const proseOf = (p: Record<string, unknown> | null): HeldItem["proseScreen"] =>
    p
      ? {
          implementation: String(p.implementation),
          questionSetVersion: String(p.question_set_version),
          modelVersion: (p.model_version as string | null) ?? null,
          tripped: p.tripped as Array<{ chunk: string; question: string }>,
        }
      : null;

  const decide = async (version: Version, body: Record<string, unknown>): Promise<void> => {
    await json("queue.decide", "POST", `/admin/versions/${runIdOf(version)}/decision`, body);
  };
  const applicationOf = async (org: { name: string }) => {
    const listed = (await json<{ applications: Array<{ id: string; scope: string }> }>("applications.list", "GET", "/admin/applications")).applications;
    const found = listed.find((a) => a.scope === org.name);
    if (!found) throw new InfrastructureError(`${org.name} has no application waiting`);
    return found.id;
  };

  const answerOf = (res: { status: number; text: string }): InternalAnswer => {
    let body: { ok?: boolean; audit_id?: string; refusal?: { message?: string }; reason?: string; message?: string } = {};
    try {
      body = JSON.parse(res.text);
    } catch {
      // A non-JSON answer carries no reason.
    }
    return { ok: body.ok === true, reason: body.refusal?.message ?? body.reason ?? body.message ?? null, auditId: body.audit_id ?? null };
  };

  const session: AdminSession = {
    handle: "admin",
    email: ADMIN_EMAIL,
    queue: {
      async list() {
        const { items } = await json<{ items: Array<Record<string, unknown>> }>("queue.list", "GET", "/admin/queue");
        return items.map((i): QueueEntry => {
          const standing = i.standing as { verified: boolean; declared_by: number | null } | undefined;
          return {
            kind: i.kind as QueueEntry["kind"],
            ...(typeof i.pack === "string" ? { pack: i.pack } : {}),
            ...(typeof i.version === "string" ? { version: i.version } : {}),
            ...(typeof i.scope === "string" ? { scope: i.scope } : {}),
            ...(typeof i.id === "string" ? { id: i.id } : {}),
            ...(typeof i.severity === "string" ? { severity: i.severity } : {}),
            ...(typeof i.priority === "boolean" ? { priority: i.priority } : {}),
            ...(standing ? { standing: { verified: standing.verified, declaredBy: standing.declared_by } } : {}),
          };
        });
      },
      async open(version) {
        return heldOf(await json("queue.open", "GET", `/admin/versions/${runIdOf(version)}`));
      },
      approve: (version) => decide(version, { decision: "approve" }),
      reject: (version, reason) => decide(version, { decision: "reject", reason }),
      quarantinePublisher: (version, reason) => decide(version, { decision: "quarantine_publisher", ...(reason ? { reason } : {}) }),
      async decision(version) {
        const row = (await sqlOf()("select decision, reason, decided_by, event_sent_at from review_decisions where run_id = ?", [runIdOf(version)]))[0];
        return row
          ? {
              decision: row.decision as RecordedDecision["decision"],
              reason: (row.reason as string | null) ?? null,
              decidedBy: String(row.decided_by),
              delivered: row.event_sent_at !== null,
            }
          : null;
      },
      async dismissReport(report) {
        await json("queue.dismissReport", "POST", `/admin/reports/${report.id}/dismiss`, {});
      },
    },
    applications: {
      async list() {
        const { applications } = await json<{ applications: Array<{ scope: string; basis: string | null }> }>("applications.list", "GET", "/admin/applications");
        return applications.map((a) => ({ scope: a.scope, basis: a.basis }));
      },
      async approve(org) {
        await json("applications.approve", "POST", `/admin/applications/${await applicationOf(org)}/decision`, { decision: "approve" });
      },
      async deny(org, reason) {
        await json("applications.deny", "POST", `/admin/applications/${await applicationOf(org)}/decision`, { decision: "deny", reason });
      },
      async revoke(org, reason) {
        await json("applications.revoke", "POST", `/admin/scopes/${aliases.alias(org.name)}/verified`, { action: "revoke", ...(reason ? { reason } : {}) });
      },
      async grant(scope) {
        await json("applications.grant", "POST", `/admin/scopes/${aliases.alias(scope.name)}/verified`, { action: "grant" });
      },
    },
    appeals: {
      async list() {
        const { items } = await json<{ items: Array<{ kind: string; pack: string; version: string; note: string }> }>("appeals.list", "GET", "/admin/queue");
        return items.filter((i) => i.kind === "appeal").map((i) => ({ pack: i.pack, version: i.version, note: i.note }));
      },
      async uphold(version) {
        await json("appeals.uphold", "POST", `/admin/appeals/${runIdOf(version)}/decision`, { outcome: "upheld" });
      },
      async deny(version) {
        await json("appeals.deny", "POST", `/admin/appeals/${runIdOf(version)}/decision`, { outcome: "denied" });
      },
    },
    reports: {
      async full(version) {
        const res = await call("GET", `/admin/versions/${runIdOf(version)}/report`);
        if (res.status >= 400) return refuse("reports.full", res);
        const text = aliases.unalias(res.text);
        const r = JSON.parse(text) as { verdict: string; rules_version: string; score: number | null; findings: HeldItem["findings"]; prose_screen: Record<string, unknown> | null };
        return { verdict: r.verdict, rulesVersion: r.rules_version, score: r.score, findings: r.findings, proseScreen: proseOf(r.prose_screen), text };
      },
      async proseScreen(version) {
        const r = await json<{ prose_screen: Record<string, unknown> | null }>("reports.proseScreen", "GET", `/admin/versions/${runIdOf(version)}/prose-screen`);
        return proseOf(r.prose_screen);
      },
      async security(report) {
        return json("reports.security", "GET", `/admin/reports/${report.id}`);
      },
    },
    async audit() {
      const rows = await sqlOf()("select action, target, detail, actor_id from recent_activity where actor_kind = 'admin' and actor_id = ? order by at, id", [ADMIN_EMAIL]);
      return rows.map((r) => ({
        action: String(r.action),
        target: r.target === null ? null : aliases.unalias(String(r.target)),
        verb: r.detail ? ((JSON.parse(String(r.detail)) as { verb?: string }).verb ?? null) : null,
        actor: String(r.actor_id),
      }));
    },
    ops: {
      async state() {
        const o = await json<{
          kill_switch: boolean; index_frozen: boolean; telemetry_mode: string; rollback_available: boolean;
          flags: OpsView["flags"]; blocked_sources: Array<{ source: string; reason: string }>;
          acknowledged: Array<{ page: string }>; recent_actions: Array<{ actor: string; verb: string; target: string | null }>;
        }>("ops.state", "GET", "/admin/ops/state");
        return {
          killSwitch: o.kill_switch,
          indexFrozen: o.index_frozen,
          telemetryMode: o.telemetry_mode,
          rollbackAvailable: o.rollback_available,
          flags: o.flags,
          blockedSources: o.blocked_sources,
          acknowledged: o.acknowledged.map((a) => a.page),
          recent: o.recent_actions,
        };
      },
      async page() {
        const res = await call("GET", "/admin/ops");
        return {
          served: res.status === 200,
          noncePolicy: /script-src[^;]*'nonce-/.test(res.headers.get("content-security-policy") ?? ""),
          inlineHandlers: /\son[a-z]+=|javascript:/i.test(res.text),
        };
      },
      async tap(request) {
        return answerOf(await call("POST", "/admin/ops/act", { body: request }));
      },
    },
    flags: {
      async set(key, value) {
        await json("flags.set", "POST", `/admin/flags/${key}`, { value });
      },
    },
    async revoke(version, o) {
      await json("versions.revoke", "POST", "/admin/revocations", { pack: version.pack.systemName, version: version.version, ...o });
    },
    disputes: {
      async list() {
        const { disputes } = await json<{ disputes: Array<{ id: string; scope: string; claimant: string; domain: string; held: boolean; holder_consented_at?: string | null; notice_attached_at?: string | null }> }>("disputes.list", "GET", "/admin/disputes");
        return disputes.map((d) => ({ id: d.id, scope: d.scope, claimant: d.claimant, domain: d.domain, held: d.held, holderConsented: !!d.holder_consented_at, noticeAttached: !!d.notice_attached_at }));
      },
      async resolve(scope, decision) {
        const { disputes } = await json<{ disputes: Array<{ id: string; scope: string }> }>("disputes.resolve", "GET", "/admin/disputes");
        const found = disputes.find((d) => d.scope === scope.name);
        if (!found) throw new InfrastructureError(`${scope.name} has no open dispute`);
        await json("disputes.resolve", "POST", `/admin/disputes/${found.id}/decision`, {
          decision: decision.kind,
          ...(decision.kind === "reassign" && decision.holderName ? { holder_name: decision.holderName } : {}),
        });
      },
    },
    holds: {
      async list() {
        const { holds } = await json<{ holds: Array<{ scope: string }> }>("holds.list", "GET", "/admin/holds");
        return holds.map((h) => aliases.unalias(h.scope));
      },
      async clear(scope) {
        await json("holds.clear", "POST", `/admin/scopes/${aliases.alias(scope.name)}/hold/clear`, {});
      },
    },
  };

  return {
    admins: {
      create: async () => session,
      notifications: () => stubModule<AdminModule>("admins").admins.notifications(),
      async visit(how) {
        const asked = how === "workers-dev" ? { host: "admin.example-subdomain.workers.dev" } : how === "preview-url" ? { host: "1a2b3c4d-admin.example-subdomain.workers.dev" } : { as: how };
        const res = await call("GET", "/admin/queue", asked);
        return { found: res.status !== 404 };
      },
      async proveDomain(scope, domain) {
        await sqlOf()("update scopes set verified_domain = ? where name = ?", [domain, aliases.alias(scope.name)]);
      },
      async promoted(version) {
        const run = (await sqlOf()("select scope_id, pack_name, version, canonical_sha256, size_bytes from validation_runs where id = ?", [runIdOf(version)]))[0];
        if (!run) throw new InfrastructureError("the version has no run");
        const at = await iso();
        const sql = sqlOf();
        await sql("insert or ignore into packs (id, scope_id, name, visibility, created_at) values (?, ?, ?, 'public', ?)", [`pack-${String(run.scope_id)}-${String(run.pack_name)}`, run.scope_id, run.pack_name, at]);
        const pack = (await sql("select id from packs where scope_id = ? and name = ?", [run.scope_id, run.pack_name]))[0]!;
        await sql(
          "insert or ignore into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values (?, ?, ?, 'active', ?, ?, ?, 0, 0)",
          [`pv-${String(pack.id)}-${String(run.version)}`, pack.id, run.version, run.canonical_sha256 ?? "0".repeat(64), run.size_bytes, at],
        );
      },
      async makePrivate(version) {
        await sqlOf()("update packs set visibility = 'private' where (scope_id, name) = (select scope_id, pack_name from validation_runs where id = ?)", [runIdOf(version)]);
      },
      async declaredBy(pack, repositories) {
        const sql = sqlOf();
        const at = await iso();
        await sql("insert or ignore into adoption_scans (id, started_at, updated_at, completed_at) values ('world-admin-scan', ?, ?, ?)", [at, at, at]);
        const rows = Array.from({ length: repositories }, (_, n) => n);
        for (let from = 0; from < rows.length; from += 15) {
          const chunk = rows.slice(from, from + 15);
          await sql(
            `insert into pack_declarations (scan_id, pack, repository, owner, settings_path) values ${chunk.map(() => "('world-admin-scan', ?, ?, ?, ?)").join(", ")}`,
            chunk.flatMap((n) => [pack.systemName, `declarer-${pack.systemName}-${n}`, `owner-${n}`, ".claudinite/settings.yml"]),
          );
        }
      },
      async holdHandle(scope) {
        await sqlOf()("update scopes set state = 'held' where name = ?", [aliases.alias(scope.name)]);
      },
      async internal(caller, request, o = {}) {
        const res = await call("POST", "/internal/call", { body: request, as: o.assertion ?? "missing", headers: { "x-packserver-caller": caller } });
        return answerOf(res);
      },
      rollbackDispatches() {
        const f = fakes();
        return f.workflowDispatch.dispatches.map((d) => ({ workflow: d.workflow, ref: d.ref, reason: d.inputs.reason ?? null, authorised: d.authorised }));
      },
      async launchMirror() {
        return await stores(driver).telemetry.get("flags/launch");
      },
      async appeal(version, note) {
        const run = (await sqlOf()("select r.id, m.user_id from validation_runs r join scope_members m on m.scope_id = r.scope_id and m.role = 'owner' where r.id = ?", [runIdOf(version)]))[0];
        if (!run) throw new InfrastructureError("the version's scope has no owner to appeal as");
        await sqlOf()("insert into review_appeals (run_id, note, submitted_by, submitted_at) values (?, ?, ?, ?)", [run.id, note, run.user_id, await iso()]);
      },
    },
    cron: createCron(driver),
    database: {
      supportedRange: () => ({ min: Number(SCHEMA_MIN), max: Number(SCHEMA_MAX) }),
      async setMigrationHead(n, o = {}) {
        const { sql } = stores(driver);
        const was = await sql(`select id, name, applied_at from ${MIGRATIONS}`);
        const stamp = (row: Record<string, unknown>) => Number(String(row.name).split("_")[0]);
        const added = `${n}_${PLACEHOLDER}_${o.kind === "contract" ? "contract_" : ""}head.sql`;
        if (o.kind === "contract" && !isContractMigration(added)) throw new InfrastructureError(`${added} is not named a contract`);
        onDispose(async () => {
          await sql(`delete from ${MIGRATIONS}`);
          for (const row of was) await sql(`insert into ${MIGRATIONS} (id, name, applied_at) values (?, ?, ?)`, [row.id, row.name, row.applied_at]);
        });
        for (const row of was.filter((r) => stamp(r) > n)) await sql(`delete from ${MIGRATIONS} where id = ?`, [row.id]);
        if (!was.some((r) => stamp(r) === n) && n > Math.max(...was.map(stamp))) await sql(`insert into ${MIGRATIONS} (name) values (?)`, [added]);
      },
    },
    storage: {
      async fingerprint() {
        const { sql, staging } = stores(driver);
        const tables = await sql("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' order by name");
        const parts: string[] = [];
        for (const { name } of tables) {
          const rows = (await sql(`select * from "${String(name)}"`)).map((row) => JSON.stringify(row)).filter((row) => !row.includes(CANARY)).sort();
          parts.push(`${String(name)}:${rows.length}:${await sha256(rows.join("\n"))}`);
        }
        const keys = (await staging.list("")).map((o) => `${o.key}:${o.size}`).filter((k) => !k.includes(CANARY)).sort();
        parts.push(`staging:${keys.length}:${await sha256(keys.join("\n"))}`);
        return sha256(parts.join("\n"));
      },
    },
    staging: stubModule("staging"),
  };
}
