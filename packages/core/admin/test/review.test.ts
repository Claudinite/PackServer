import { createAudit } from "../../audit/index.ts";
import { migratedD1 } from "../../identity/testing.ts";
import { FakeClock, FakeMail, FakeQueue, FakeR2, FakeRng, FakeWorkflow } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import {
  adminReport, byStanding, decideAppeal, decideHeld, decideVerifiedApplication, dismissReport, grantVerifiedPublisher, heldVersions, openSecurityReports, reviewQueue,
  revokeVerifiedPublisher, type AdminIdentity, type AdminPorts, type HeldVersion,
} from "../index.ts";

const ADMIN: AdminIdentity = { email: "admin@example.test", sub: "admin-1" };
const AT = "2026-10-26T12:00:00.000Z";

function fixture() {
  const { d1 } = migratedD1();
  const clock = new FakeClock(Date.parse(AT));
  const rng = new FakeRng(7);
  const auditQueue = new FakeQueue();
  const mail = new FakeMail();
  const workflows = new FakeWorkflow();
  const validationReports = new FakeR2();
  const ports: AdminPorts = {
    d1, clock, rng, mail, workflows, validationReports,
    dns: { resolveTxt: async () => [] },
    wellKnown: { fetch: async () => ({ status: 404, body: "" }) } as never,
    reindex: new FakeQueue(),
    siteOrigin: "https://registry.example",
    audit: createAudit({ clock, rng, queue: auditQueue, d1 }, { ipKey: "" }),
  };
  const seed = async (sql: string, params: unknown[] = []) => void (await d1.query(sql, params));
  return { d1, ports, mail, workflows, validationReports, auditQueue, seed };
}
type Fixture = ReturnType<typeof fixture>;

async function scope(f: Fixture, name: string, o: { owner?: string; proof?: boolean; verified?: boolean } = {}) {
  const owner = o.owner ?? `u-${name}`;
  await f.seed("insert or ignore into users (id, handle, created_at) values (?, ?, ?)", [owner, `h-${name}`, AT]);
  await f.seed("insert or ignore into user_emails (user_id, address, source, created_at) values (?, ?, 'github', ?)", [owner, `${name}@example.test`, AT]);
  await f.seed("insert into scopes (id, name, kind, state, verified_domain, created_at) values (?, ?, 'org', 'active', ?, ?)", [`s-${name}`, name, o.proof ? `${name}.example` : null, AT]);
  await f.seed("insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, 'owner', ?)", [`s-${name}`, owner, AT]);
  if (o.verified) await f.seed("insert into vp_applications (id, scope_id, state, applied_by, applied_at, decided_at, basis) values (?, ?, 'approved', ?, ?, ?, 'domain')", [`a-${name}`, `s-${name}`, owner, AT, AT]);
}

let runs = 0;
async function hold(f: Fixture, scopeName: string, o: { version?: string; at?: string; verdict?: string; instance?: string | null } = {}) {
  const id = `run-${++runs}`;
  await f.seed(
    `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, status, verdict, start_after, created_at, updated_at, finished_at, workflow_instance_id)
     values (?, 'publish', 'upload', ?, 'tool', ?, ?, ?, 'k', 'd', 10, 'finished', ?, ?, ?, ?, ?, ?)`,
    [id, `s-${scopeName}`, o.version ?? "1.0.0", `user:u-${scopeName}`, `cred-${id}`, o.verdict ?? "hold", AT, o.at ?? AT, o.at ?? AT, o.at ?? AT, o.instance === undefined ? `wf-${id}` : o.instance],
  );
  if (o.instance !== null) await f.workflows.create({ id: o.instance ?? `wf-${id}`, params: {} });
  return id;
}

async function declared(f: Fixture, pack: string, repositories: number, scan = "scan-1") {
  await f.seed("insert or ignore into adoption_scans (id, started_at, updated_at, completed_at) values (?, ?, ?, ?)", [scan, AT, AT, AT]);
  for (let n = 0; n < repositories; n++) {
    await f.seed("insert into pack_declarations (scan_id, pack, repository, owner, settings_path) values (?, ?, ?, 'o', 's.yml')", [scan, pack, `${pack}-r${n}`]);
  }
}

describe("the held queue", () => {
  it("orders by verified status, then declaring repositories, then age", async () => {
    const f = fixture();
    await scope(f, "fresh");
    await scope(f, "few");
    await scope(f, "many");
    await scope(f, "vp", { proof: true, verified: true });
    await scope(f, "lapsed", { verified: true });
    const oldest = await hold(f, "fresh", { at: "2026-10-01T00:00:00.000Z" });
    const few = await hold(f, "few", { at: "2026-10-10T00:00:00.000Z" });
    const many = await hold(f, "many", { at: "2026-10-11T00:00:00.000Z" });
    const lapsed = await hold(f, "lapsed", { at: "2026-10-12T00:00:00.000Z" });
    const vp = await hold(f, "vp", { at: "2026-10-25T00:00:00.000Z" });
    await declared(f, "@many/tool", 500);
    await declared(f, "@few/tool", 5);
    const queue = await heldVersions(f.ports);
    expect(queue.map((h) => h.run_id)).toEqual([vp, many, few, oldest, lapsed]);
    expect(queue[0]!.standing).toEqual({ verified: true, declared_by: 0 });
    expect(queue[1]!.standing).toEqual({ verified: false, declared_by: 500 });
  });

  it("knows no declaring count until a scan has completed", async () => {
    const f = fixture();
    await scope(f, "a");
    await hold(f, "a");
    expect((await heldVersions(f.ports))[0]!.standing.declared_by).toBeNull();
  });

  it("leaves out runs that are not held for a person, or already decided", async () => {
    const f = fixture();
    await scope(f, "a");
    await hold(f, "a", { verdict: "pass" });
    const decided = await hold(f, "a", { version: "1.0.1" });
    await decideHeld(f.ports, decided, ADMIN, { kind: "approve" });
    expect(await heldVersions(f.ports)).toEqual([]);
  });

  it("breaks an exact tie by run id", () => {
    const base = { scope: "s", pack: "@s/p", version: "1", held_at: AT, standing: { verified: false, declared_by: null } };
    const sorted = [{ ...base, run_id: "b" }, { ...base, run_id: "a" }].sort(byStanding) as HeldVersion[];
    expect(sorted.map((h) => h.run_id)).toEqual(["a", "b"]);
  });
});

describe("a decision on a held version", () => {
  it("is recorded in the database, wakes the waiting instance and is audited with the admin", async () => {
    const f = fixture();
    await scope(f, "a");
    const id = await hold(f, "a");
    expect(await decideHeld(f.ports, id, ADMIN, { kind: "approve" })).toMatchObject({ ok: true, pack: "@a/tool" });
    expect((await f.d1.query("select decision, decided_by, event_sent_at from review_decisions where run_id = ?", [id])).rows[0]).toMatchObject({ decision: "approve", decided_by: ADMIN.email });
    expect((await f.d1.query("select event_sent_at from review_decisions where run_id = ?", [id])).rows[0]!.event_sent_at).not.toBeNull();
    expect(f.workflows.events).toEqual([{ id: `wf-${id}`, type: "review", payload: { run_id: id, decision: "approve" } }]);
    expect((await f.d1.query("select actor_id, action, target, detail from recent_activity")).rows).toEqual([
      { actor_id: ADMIN.email, action: "admin.action", target: "version:@a/tool@1.0.0", detail: JSON.stringify({ verb: "review.approve" }) },
    ]);
  });

  it("stands when no instance is waiting", async () => {
    const f = fixture();
    await scope(f, "a");
    const gone = await hold(f, "a", { instance: null });
    const finished = await hold(f, "a", { version: "1.0.1", instance: "wf-finished" });
    f.workflows.instances.delete("wf-finished");
    for (const id of [gone, finished]) {
      expect(await decideHeld(f.ports, id, ADMIN, { kind: "approve" })).toMatchObject({ ok: true });
      expect((await f.d1.query("select decision, event_sent_at from review_decisions where run_id = ?", [id])).rows[0]).toEqual({ decision: "approve", event_sent_at: null });
    }
  });

  it("is made once", async () => {
    const f = fixture();
    await scope(f, "a");
    const id = await hold(f, "a");
    await decideHeld(f.ports, id, ADMIN, { kind: "approve" });
    expect(await decideHeld(f.ports, id, ADMIN, { kind: "reject", reason: "changed my mind" })).toMatchObject({ ok: false, reason: "already_decided" });
    expect(f.workflows.events).toHaveLength(1);
  });

  it("is refused for a run that is unknown or not held, and a rejection needs a reason within the limit", async () => {
    const f = fixture();
    await scope(f, "a");
    const passed = await hold(f, "a", { verdict: "pass" });
    const id = await hold(f, "a", { version: "1.0.1" });
    expect(await decideHeld(f.ports, "nope", ADMIN, { kind: "approve" })).toMatchObject({ reason: "unknown" });
    expect(await decideHeld(f.ports, passed, ADMIN, { kind: "approve" })).toMatchObject({ reason: "not_held" });
    expect(await decideHeld(f.ports, id, ADMIN, { kind: "reject", reason: "  " })).toMatchObject({ reason: "reason_required" });
    expect(await decideHeld(f.ports, id, ADMIN, { kind: "reject", reason: "x".repeat(1001) })).toMatchObject({ reason: "reason_too_long" });
    expect((await f.d1.query("select count(*) as n from review_decisions")).rows[0]!.n).toBe(0);
  });

  it("heals on a retry of the same decision when the audit write failed after the row", async () => {
    const f = fixture();
    await scope(f, "a");
    const id = await hold(f, "a");
    const audit = f.ports.audit;
    let failing = true;
    const flaky: AdminPorts = { ...f.ports, audit: async (...args) => { if (failing) throw new Error("audit queue down"); return audit(...args); } };
    await expect(decideHeld(flaky, id, ADMIN, { kind: "quarantine_publisher", reason: "again" })).rejects.toThrow("audit queue down");
    expect((await f.d1.query("select state from scopes where id = 's-a'")).rows[0]!.state).toBe("held");
    expect(f.auditQueue.messages).toHaveLength(0);
    failing = false;
    expect(await decideHeld(flaky, id, ADMIN, { kind: "quarantine_publisher", reason: "again" })).toMatchObject({ ok: true });
    expect(f.auditQueue.messages).toHaveLength(1);
    expect(f.workflows.events).toHaveLength(1);
    expect(f.mail.inbox("a@example.test")).toHaveLength(0);
    expect(await decideHeld(f.ports, id, ADMIN, { kind: "approve" })).toMatchObject({ ok: false, reason: "already_decided" });
  });

  it("decides only a finished, non-synthetic publish run", async () => {
    const f = fixture();
    await scope(f, "a");
    const synthetic = await hold(f, "a");
    const probe = await hold(f, "a", { version: "1.0.1" });
    const running = await hold(f, "a", { version: "1.0.2" });
    await f.seed("update validation_runs set synthetic = 1 where id = ?", [synthetic]);
    await f.seed("update validation_runs set kind = 'dry-run' where id = ?", [probe]);
    await f.seed("update validation_runs set status = 'running' where id = ?", [running]);
    for (const id of [synthetic, probe, running]) expect(await decideHeld(f.ports, id, ADMIN, { kind: "approve" })).toMatchObject({ ok: false, reason: "not_held" });
  });

  it("sends a rejection's reason to the owners, and an approval nothing", async () => {
    const f = fixture();
    await scope(f, "a");
    await decideHeld(f.ports, await hold(f, "a"), ADMIN, { kind: "approve" });
    expect(f.mail.sent).toEqual([]);
    await decideHeld(f.ports, await hold(f, "a", { version: "1.0.1" }), ADMIN, { kind: "reject", reason: "Not ours to run" });
    expect(f.mail.inbox("a@example.test")).toHaveLength(1);
    expect(f.mail.inbox("a@example.test")[0]!.text).toContain("Not ours to run");
  });

  it("holds the publisher's scope when the publisher is quarantined", async () => {
    const f = fixture();
    await scope(f, "a");
    await scope(f, "b");
    await decideHeld(f.ports, await hold(f, "a"), ADMIN, { kind: "quarantine_publisher" });
    const states = (await f.d1.query("select name, state from scopes order by name")).rows;
    expect(states).toEqual([{ name: "a", state: "held" }, { name: "b", state: "active" }]);
    expect(f.mail.inbox("a@example.test")[0]!.text).toContain("suspended");
  });
});

describe("an appeal", () => {
  async function appealed(f: Fixture) {
    await scope(f, "a");
    const id = await hold(f, "a");
    await f.seed("insert into review_appeals (run_id, note, submitted_by, submitted_at) values (?, 'please', 'u-a', ?)", [id, AT]);
    return id;
  }

  it("is decided once, wakes the instance and tells the owners", async () => {
    const f = fixture();
    const id = await appealed(f);
    expect(await decideAppeal(f.ports, id, ADMIN, "upheld")).toMatchObject({ ok: true });
    expect(f.workflows.events).toEqual([{ id: `wf-${id}`, type: "review", payload: { run_id: id, appeal: "upheld" } }]);
    expect(f.mail.inbox("a@example.test")[0]!.text).toContain("upheld");
    expect(await decideAppeal(f.ports, id, ADMIN, "denied")).toMatchObject({ ok: false, reason: "not_open" });
    expect(await decideAppeal(f.ports, "nope", ADMIN, "denied")).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("shows in the queue only while open", async () => {
    const f = fixture();
    const id = await appealed(f);
    expect((await reviewQueue(f.ports)).items.filter((i) => i.kind === "appeal")).toMatchObject([{ run_id: id, note: "please", pack: "@a/tool" }]);
    await decideAppeal(f.ports, id, ADMIN, "denied");
    expect((await reviewQueue(f.ports)).items.filter((i) => i.kind === "appeal")).toEqual([]);
  });

  it("cannot be longer than the ceiling the database holds", async () => {
    const f = fixture();
    await scope(f, "a");
    const id = await hold(f, "a");
    await expect(f.d1.query("insert into review_appeals (run_id, note, submitted_by, submitted_at) values (?, ?, 'u-a', ?)", [id, "x".repeat(2001), AT])).rejects.toThrow();
    await f.d1.query("insert into review_appeals (run_id, note, submitted_by, submitted_at) values (?, ?, 'u-a', ?)", [id, "x".repeat(2000), AT]);
  });
});

describe("Verified Publisher decisions", () => {
  async function applied(f: Fixture, name = "acme") {
    await scope(f, name, { proof: true });
    await f.seed("insert into mfa_policies (scope_id, policy, updated_at) values (?, 'passkey', ?)", [`s-${name}`, AT]).catch(() => undefined);
    await f.seed("insert into vp_applications (id, scope_id, state, applied_by, applied_at, basis) values (?, ?, 'pending', ?, ?, 'domain')", [`app-${name}`, `s-${name}`, `u-${name}`, AT]);
    return `app-${name}`;
  }

  it("records a direct grant as an approved application, once, and audits it", async () => {
    const f = fixture();
    await scope(f, "claudinite", { proof: true });
    expect(await grantVerifiedPublisher(f.ports, "claudinite", ADMIN)).toEqual({ ok: true, scope: "claudinite" });
    expect((await f.d1.query("select state, basis from vp_applications")).rows).toEqual([{ state: "approved", basis: "domain" }]);
    expect(await grantVerifiedPublisher(f.ports, "claudinite", ADMIN)).toMatchObject({ ok: false, reason: "already_verified" });
    expect(await grantVerifiedPublisher(f.ports, "nobody", ADMIN)).toMatchObject({ ok: false, reason: "unknown" });
    expect(f.ports.reindex).toBeDefined();
    expect((await f.d1.query("select detail from recent_activity")).rows).toEqual([{ detail: JSON.stringify({ verb: "verified.grant" }) }]);
  });

  it("settles a pending application when granted directly", async () => {
    const f = fixture();
    await applied(f);
    await grantVerifiedPublisher(f.ports, "acme", ADMIN);
    expect((await f.d1.query("select state from vp_applications")).rows).toEqual([{ state: "approved" }]);
  });

  it("denies with a reason that is required and bounded, and revokes only what was granted", async () => {
    const f = fixture();
    const id = await applied(f);
    expect(await decideVerifiedApplication(f.ports, id, ADMIN, { kind: "deny", reason: " " })).toMatchObject({ ok: false, reason: "reason_required" });
    expect(await decideVerifiedApplication(f.ports, id, ADMIN, { kind: "deny", reason: "x".repeat(1001) })).toMatchObject({ ok: false, reason: "reason_too_long" });
    expect(await decideVerifiedApplication(f.ports, id, ADMIN, { kind: "deny", reason: "Redirect only" })).toEqual({ ok: true, scope: "acme" });
    expect(f.mail.inbox("acme@example.test")[0]!.text).toContain("Reason: Redirect only");
    expect(await decideVerifiedApplication(f.ports, id, ADMIN, { kind: "deny", reason: "again" })).toMatchObject({ ok: false, reason: "not_pending" });
    expect(await revokeVerifiedPublisher(f.ports, "acme", ADMIN, null)).toMatchObject({ ok: false, reason: "not_verified" });
    expect(await revokeVerifiedPublisher(f.ports, "nobody", ADMIN, null)).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("records the admin under an account of their own, once", async () => {
    const f = fixture();
    await scope(f, "a", { proof: true });
    await scope(f, "b", { proof: true });
    await grantVerifiedPublisher(f.ports, "a", ADMIN);
    await grantVerifiedPublisher(f.ports, "b", ADMIN);
    const deciders = (await f.d1.query("select distinct decided_by from vp_applications")).rows;
    expect(deciders).toHaveLength(1);
    expect((await f.d1.query("select handle from users where id = ?", [String(deciders[0]!.decided_by)])).rows).toEqual([{ handle: null }]);
  });
});

describe("security reports in the queue", () => {
  async function report(f: Fixture, id: string, severity: string, at: string, o: { kind?: string; status?: string } = {}) {
    await f.seed("insert or ignore into packs (id, scope_id, name, visibility, created_at) values ('p-a', 's-a', 'tool', 'public', ?)", [AT]);
    await f.seed(
      `insert into reports (id, pack_id, reporter_id, kind, version, severity, title, repro, environment, status, route, disclosure_deadline, created_at, updated_at)
       values (?, 'p-a', 'u-a', ?, '1.0.0', ?, 'T', 'R', 'E', ?, 'registry_security', ?, ?, ?)`,
      [id, o.kind ?? "security", severity, o.status ?? "open", (o.kind ?? "security") === "security" ? AT : null, at, at],
    );
  }

  it("lists open security reports oldest first, urgent ones at the front of the whole queue", async () => {
    const f = fixture();
    await scope(f, "a");
    await hold(f, "a");
    await report(f, "r-low", "low", "2026-10-01T00:00:00.000Z");
    await report(f, "r-crit", "critical", "2026-10-02T00:00:00.000Z");
    await report(f, "r-bug", "high", "2026-10-03T00:00:00.000Z", { kind: "bug" });
    await report(f, "r-closed", "high", "2026-10-04T00:00:00.000Z", { status: "fixed" });
    expect((await openSecurityReports(f.ports)).map((r) => [r.id, r.priority])).toEqual([["r-low", false], ["r-crit", true]]);
    expect((await reviewQueue(f.ports)).items.map((i) => i.kind)).toEqual(["report", "held-version", "report"]);
    expect((await reviewQueue(f.ports)).items[0]).toMatchObject({ id: "r-crit" });
  });

  it("dismisses an open report once", async () => {
    const f = fixture();
    await scope(f, "a");
    await report(f, "r-1", "high", AT);
    expect(await dismissReport(f.ports, "r-1", ADMIN)).toEqual({ ok: true });
    expect(await dismissReport(f.ports, "r-1", ADMIN)).toEqual({ ok: false, reason: "not_open" });
    expect(await dismissReport(f.ports, "nope", ADMIN)).toEqual({ ok: false, reason: "unknown" });
    expect((await openSecurityReports(f.ports))).toEqual([]);
  });
});

describe("the full report", () => {
  const stored = (extra: object = {}) => ({
    run_id: "run-x", pack: "@a/tool", version: "2.3.1", rules_version: "2026.10.1", started_at: AT, finished_at: AT, verdict: "hold",
    steps: [{ step: 1, name: "admission", outcome: "pass", ms: 4 }],
    findings: [{ rule: "text.url-install", class: "hold", file: "README.md", line: 3, quote: "pip install https://x", hint: "Say what it does" }],
    tree_hash: null, canonical_sha256: null, source_verified: false,
    prose_screen: { implementation: "model-screen", question_set_version: "q1", model_version: "m9", cost_usd: 0.42 },
    score: null, ...extra,
  });
  const put = (f: Fixture, key: string, value: unknown) => f.validationReports.put(key, new TextEncoder().encode(JSON.stringify(value)));

  it("names the implementation and the tripped questions, and copies nothing numeric from the stored files", async () => {
    const f = fixture();
    await put(f, "runs/run-x/report.json", stored());
    await put(f, "runs/run-x/admin.json", { implementation: "model-screen", thresholds: { tripped: [{ chunk: "c1", question: "q-exfil", probability: 0.93, threshold: 0.8 }] } });
    const view = await adminReport(f.validationReports, "run-x", null);
    expect(view?.prose_screen).toEqual({ implementation: "model-screen", question_set_version: "q1", model_version: "m9", tripped: [{ chunk: "c1", question: "q-exfil" }] });
    expect(JSON.stringify(view)).not.toMatch(/threshold|probabilit|\b0\.\d+\b/i);
    expect(view?.findings[0]!.quote).toBe("pip install https://x");
  });

  it("is absent for a run without a report, and rejects a stored report that is not one", async () => {
    const f = fixture();
    expect(await adminReport(f.validationReports, "run-none", null)).toBeNull();
    await put(f, "runs/run-bad/report.json", { nonsense: true });
    await expect(adminReport(f.validationReports, "run-bad", null)).rejects.toThrow();
  });

  it("shows a static-only run without tripped questions", async () => {
    const f = fixture();
    await put(f, "runs/run-x/report.json", stored({ prose_screen: { implementation: "static-only", question_set_version: "q1", model_version: null, cost_usd: null } }));
    expect((await adminReport(f.validationReports, "run-x", null))?.prose_screen).toEqual({ implementation: "static-only", question_set_version: "q1", model_version: null, tripped: [] });
  });
});
