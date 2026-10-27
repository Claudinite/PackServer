import { describe, expect, it } from "vitest";
import { runAlerts } from "../src/alerts/cycle";
import { alertHarness, row, toHour } from "./alert-support";

const MIN = 60_000;

describe("the takedown timer (REQ-MOD-009)", () => {
  async function prioritisedAt(minutesAgo: number) {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rows = [row("moderation.report_prioritised", { report: "r1", pack: "@acme/lib", version: "1.0.0" }, { ts: h.fakes.clock.now() - minutesAgo * MIN })];
    return h;
  }

  it("does nothing at 59 minutes", async () => {
    const h = await prioritisedAt(59);
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls.filter((c) => c.method === "quarantine_version")).toEqual([]);
    expect(h.pager.pushes.filter((p) => p.title.startsWith("page.takedown_overdue"))).toEqual([]);
  });

  it("holds the version through the admin API at 61 minutes and pages", async () => {
    const h = await prioritisedAt(61);
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls).toEqual([{ method: "quarantine_version", pack: "@acme/lib", version: "1.0.0", reason: "security report undecided for an hour" }]);
    const [push] = h.pager.pushes.filter((p) => p.title.startsWith("page.takedown_overdue"));
    expect(push?.message).toContain("Already done: The judge held the version");
  });

  it("holds once however many cycles follow", async () => {
    const h = await prioritisedAt(61);
    await runAlerts(h.cycleDeps());
    h.fakes.clock.advance("5m");
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls).toHaveLength(1);
  });

  it("leaves a report a human decided", async () => {
    const h = await prioritisedAt(90);
    h.data.rows.push(row("moderation.takedown_completed", { report: "r1" }));
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls).toEqual([]);
  });

  it("is a ticket at night and a page when the support window opens, the hold made at once", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 3);
    h.data.rows = [row("moderation.report_prioritised", { report: "r2", pack: "@acme/lib", version: "2.0.0" }, { ts: h.fakes.clock.now() - 70 * MIN })];
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls).toHaveLength(1);
    expect(h.pager.pushes.filter((p) => p.title.startsWith("page.takedown_overdue"))).toEqual([]);
    toHour(h.fakes.clock, 8);
    h.data.rows = [row("moderation.report_prioritised", { report: "r2", pack: "@acme/lib", version: "2.0.0" }, { ts: h.fakes.clock.now() - 300 * MIN })];
    await runAlerts(h.cycleDeps());
    expect(h.pager.pushes.filter((p) => p.title.startsWith("page.takedown_overdue"))).toHaveLength(1);
    expect(h.admin.calls).toHaveLength(1);
  });
});

describe("page triggers", () => {
  it("a server-observed mismatch quarantines the named version and pages", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rows = [row("download.hash_mismatch", { version_id: "v-1", pack: "@a/b", version: "1.2.3" })];
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls).toEqual([{ method: "quarantine_version", pack: "@a/b", version: "1.2.3", reason: "server-observed hash mismatch" }]);
    expect(h.pager.pushes[0]?.title).toBe("page.hash_mismatch (RB-03)");
  });

  it("a mismatch that does not name the version still pages, and says the action was not taken", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rows = [row("download.hash_mismatch", { version_id: "v-1" })];
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls).toEqual([]);
    expect(h.pager.pushes[0]?.title).toBe("page.hash_mismatch (RB-03)");
    expect(h.pager.pushes[0]?.message).toContain("No automatic action was possible");
    expect(h.pager.pushes[0]?.message).not.toContain("Already done");
  });

  it("a private version quarantined by two covering reporters pages (IT-TELEM-009)", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rows = [row("moderation.quarantined", { pack: "@acme/secret", version: "1.0.0", reason: "hash_mismatch_reports", principals: 2 })];
    await runAlerts(h.cycleDeps());
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.hash_mismatch (RB-03)"]);
    expect(h.admin.calls).toEqual([]);
    // Any other quarantine is not this page.
    const other = alertHarness();
    toHour(other.fakes.clock, 12);
    other.data.rows = [row("moderation.quarantined", { pack: "@a/b", version: "1.0.0", reason: "security_report" })];
    await runAlerts(other.cycleDeps());
    expect(other.pager.pushes).toEqual([]);
  });

  it("a broken audit chain or an audit DLQ message pages (IT-AUDIT-005)", async () => {
    for (const rows of [[row("audit.chain_broken", { key: "k" })], [row("queue.dlq", { queue: "audit" })]]) {
      const h = alertHarness();
      toHour(h.fakes.clock, 12);
      h.data.rows = rows;
      await runAlerts(h.cycleDeps());
      expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.audit_pipeline (RB-08)"]);
    }
    const other = alertHarness();
    toHour(other.fakes.clock, 12);
    other.data.rows = [row("queue.dlq", { queue: "reindex" })];
    await runAlerts(other.cycleDeps());
    expect(other.pager.pushes).toEqual([]);
  });

  it("a Cloudflare account event no release accounts for pages, and a signing-key binding is its own page (OPS-013)", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    await runAlerts(h.cycleDeps({ facts: { ...h.cycleDeps().facts, audit: [{ id: "e1", signingKey: false }, { id: "e2", signingKey: true }] } }));
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.account_change (RB-10)", "page.signing_key_read (RB-07)"]);
  });

  it("an unexpected index key pages and does nothing else", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rows = [row("index.key_changed", { key_id: "x" })];
    await runAlerts(h.cycleDeps());
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.index_key_changed (RB-06)"]);
    expect(h.admin.calls).toEqual([]);
  });

  it("two failed index fetches in a row page; a stale root pages", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    const now = h.fakes.clock.now();
    const fetches = new Map([["web-1", [{ ok: false, at: now - 10 * MIN, staleS: null }, { ok: false, at: now - 5 * MIN, staleS: null }]], ["web-2", [{ ok: true, at: now, staleS: 90_000 }]]]);
    await runAlerts(h.cycleDeps({ facts: { ...h.cycleDeps().facts, indexFetches: fetches } }));
    expect(h.pager.pushes.map((p) => p.title).sort()).toEqual(["page.index_signature (RB-04)", "page.index_stale (RB-05)"]);
  });

  it("a root older than ten minutes after a promotion pages", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    const now = h.fakes.clock.now();
    h.data.rows = [row("publish.promoted", { pack: "@a/b" }, { ts: now - 20 * MIN })];
    const fetches = new Map([["web-1", [{ ok: true, at: now, staleS: 25 * 60 }]]]);
    await runAlerts(h.cycleDeps({ facts: { ...h.cycleDeps().facts, indexFetches: fetches } }));
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.index_stale (RB-05)"]);
    const fresh = alertHarness();
    toHour(fresh.fakes.clock, 12);
    fresh.data.rows = [row("publish.promoted", { pack: "@a/b" }, { ts: fresh.fakes.clock.now() - 20 * MIN })];
    await runAlerts(fresh.cycleDeps({ facts: { ...fresh.cycleDeps().facts, indexFetches: new Map([["web-1", [{ ok: true, at: fresh.fakes.clock.now(), staleS: 60 }]]]) } }));
    expect(fresh.pager.pushes).toEqual([]);
  });

  it("a stalled validation queue or failing workflows page in support hours", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rows = [row("queue.backlog", { queue: "validation" }, { ts: h.fakes.clock.now() - MIN, d2: 31 * 60 })];
    await runAlerts(h.cycleDeps());
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.publish_stalled (RB-13)"]);
    const w = alertHarness();
    toHour(w.fakes.clock, 12);
    w.data.rows = [row("workflow.instance_finished", { status: "complete" }, { n1h: 90 }), row("workflow.instance_finished", { status: "errored" }, { n1h: 10 })];
    await runAlerts(w.cycleDeps());
    expect(w.pager.pushes.map((p) => p.title)).toEqual(["page.publish_stalled (RB-13)"]);
  });

  it("credential stuffing pages only once it continues past the locks", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rows = [row("auth.login_failed_burst", { past_locks: false })];
    await runAlerts(h.cycleDeps());
    expect(h.pager.pushes).toEqual([]);
    h.data.rows = [row("auth.login_failed_burst", { past_locks: true })];
    await runAlerts(h.cycleDeps());
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.credential_stuffing (RB-12)"]);
  });

  it("a failed rollback pages", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    await runAlerts(h.cycleDeps({ release: { release_id: "r9", state: "rollback_failed", workers: {} } }));
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.rollback_failed (RB-09)"]);
  });
});

describe("burn rate and release-aware routing", () => {
  const HOUR = 3_600_000;
  const burning = (version: string) => ({ version_id: version, counts: { [HOUR]: { total: 10_000, bad: 1000 }, [5 * MIN]: { total: 900, bad: 90 }, [6 * HOUR]: { total: 0, bad: 0 }, [30 * MIN]: { total: 0, bad: 0 }, [24 * HOUR]: { total: 0, bad: 0 }, [2 * HOUR]: { total: 0, bad: 0 }, [72 * HOUR]: { total: 0, bad: 0 } } });
  const rolling = { release_id: "r1", state: "rolling", workers: { web: { version_id: "web-new", changed: true } } };

  it("pages tier 1 when the incumbent burns", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.burnRows = [burning("web-old")];
    await runAlerts(h.cycleDeps());
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.read_path_burn (RB-01)"]);
    expect(h.pager.pushes[0]?.message).toContain("Tier: 1");
  });

  it("leaves a candidate-only burn to the controller for ten minutes, then pages", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.burnRows = [burning("web-new")];
    await runAlerts(h.cycleDeps({ release: rolling }));
    expect(h.pager.pushes).toEqual([]);
    h.fakes.clock.advance("9m");
    await runAlerts(h.cycleDeps({ release: rolling }));
    expect(h.pager.pushes).toEqual([]);
    h.fakes.clock.advance("2m");
    await runAlerts(h.cycleDeps({ release: rolling }));
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.read_path_burn (RB-01)"]);
  });

  it("pages at once when the incumbent burns beside the candidate", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.burnRows = [burning("web-new"), burning("web-old")];
    await runAlerts(h.cycleDeps({ release: rolling }));
    expect(h.pager.pushes).toHaveLength(1);
  });

  it("before launch a candidate-only burn pages nobody: the deploy job fails on the gate", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.burnRows = [burning("web-new")];
    await runAlerts(h.cycleDeps({ release: rolling, mode: "pre-launch" }));
    h.fakes.clock.advance("30m");
    await runAlerts(h.cycleDeps({ release: rolling, mode: "pre-launch" }));
    expect(h.pager.pushes).toEqual([]);
    expect(h.fakes.mail.sent).toEqual([]);
  });

  it("is quiet below the sustained rate for tier 1", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.burnRows = [burning("web-old")];
    await runAlerts(h.cycleDeps({ facts: { ...h.cycleDeps().facts, requestsPerSecond: 0.2 } }));
    expect(h.pager.pushes).toEqual([]);
  });
});

describe("tickets, polling and the daily test", () => {
  it("a publish flood turns the new-pack kill switch on and tickets it", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rateRows = [{ signal: "publish.received", hour: 400, week: 400 + 167 * 5 }];
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls).toEqual([{ method: "enable_new_pack_kill_switch", reason: "publish rate over 20 times the weekly baseline" }]);
    expect(h.fakes.mail.inbox("ops@example.test").some((m) => m.subject === "ticket.abuse_flood")).toBe(true);
  });

  it("an ordinary week is not a flood", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.data.rateRows = [{ signal: "publish.received", hour: 12, week: 12 + 167 * 5 }];
    await runAlerts(h.cycleDeps());
    expect(h.admin.calls).toEqual([]);
  });

  it("polls queue backlogs into queue.backlog signals, leaving an unknown age unknown", async () => {
    const h = alertHarness();
    h.platform.queues = [{ queue: "audit", depth: 4, oldestAgeS: 12 }, { queue: "validation", depth: 9, oldestAgeS: null }];
    await runAlerts(h.cycleDeps());
    const [audit, validation] = h.signals("queue.backlog");
    expect(audit?.attrs).toMatchObject({ queue: "audit", depth: 4, oldest_age_s: 12 });
    expect(validation?.attrs).toMatchObject({ queue: "validation", depth: 9 });
    expect(validation?.attrs).not.toHaveProperty("oldest_age_s");
  });

  it("tickets failing Logpush jobs, and a failed poll is a cycle failure and not a quiet zero", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.platform.failingJobs = 2;
    await runAlerts(h.cycleDeps());
    expect(h.fakes.mail.inbox("ops@example.test").some((m) => m.subject === "ticket.monitoring")).toBe(true);
    const broken = alertHarness();
    broken.platform.failingLogpushJobs = async () => { throw new Error("the Cloudflare API answered 403 for zones"); };
    const run = await runAlerts(broken.cycleDeps());
    expect(run.failures).toEqual(["logpush: the Cloudflare API answered 403 for zones"]);
  });

  it("emits budget.usage every cycle", async () => {
    const h = alertHarness();
    await runAlerts(h.cycleDeps({ facts: { ...h.cycleDeps().facts, requestsToday: 250, allowance: 1000 } }));
    expect(h.signals("budget.usage")[0]?.attrs).toMatchObject({ requests_today: 250, log_allowance: 1000, log_share: 0.25, telemetry_mode: "normal" });
  });

  it("sends the page test once a day, quietly and outside the router, and tickets a failure", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    await runAlerts(h.cycleDeps());
    await runAlerts(h.cycleDeps());
    expect(h.pager.quiet.map((p) => p.title)).toEqual(["monitoring.page_test"]);
    expect(h.pager.pushes).toEqual([]);
    expect(h.signals("monitoring.page_test").map((s) => s.attrs.ok)).toEqual([true]);
    expect((await h.store.state()).sent).toEqual([]);
    h.fakes.clock.advance("24h");
    h.pager.failing = true;
    await runAlerts(h.cycleDeps());
    expect(h.signals("monitoring.page_test").map((s) => s.attrs.ok)).toEqual([true, false]);
    expect(h.fakes.mail.sent.some((m) => m.subject === "ticket.monitoring")).toBe(true);
  });

  it("keeps going when one input fails", async () => {
    const h = alertHarness();
    h.data.events = async () => { throw new Error("analytics engine answered 500 for alert events"); };
    const run = await runAlerts(h.cycleDeps());
    expect(run.failures).toEqual(["alert reads: analytics engine answered 500 for alert events"]);
    expect(h.signals("budget.usage")).toHaveLength(1);
    expect(h.signals("monitoring.page_test")).toHaveLength(1);
  });
});

