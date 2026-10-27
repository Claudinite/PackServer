import { RECOMPUTE_PACKS_PER_RUN } from "@packserver/core/community";
import { MemoryAuditBucket } from "@packserver/core/audit/testing";
import { migratedD1 } from "@packserver/core/identity/testing";
import { fileCounterNotice, removeOnCopyrightNotice } from "@packserver/core/moderation";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it, vi } from "vitest";
import type { AdminRuntime } from "../src/bindings";
import { BudgetExhausted, queryBudget } from "../src/crons/budget";
import { CRON_HOURLY, CRON_JOBS, CRON_REPORTS, CRON_ROLLUP, INVOCATION_QUERIES, JOB_QUERIES, runCron, type CronJob } from "../src/crons";
import { community } from "../src/crons/community";
import { githubProofLapse } from "../src/crons/github-proof-lapse";
import { lifecycle } from "../src/crons/lifecycle";
import { moderation } from "../src/crons/moderation";
import { reportNotices } from "../src/crons/report-notices";
import { rollup } from "../src/crons/rollup";
import { syntheticExpiry } from "../src/crons/synthetic-expiry";
import { opsPorts } from "../src/ops/context";

const D1_PARAMS_PER_STATEMENT = 100;
const AT = "2026-10-26T12:00:00.000Z";

function fixture() {
  const fakes = createFakePorts({ worker: "admin" });
  const { d1, db } = migratedD1();
  const runtime: AdminRuntime = {
    worker: "admin",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...fakes, d1, auditBucket: new MemoryAuditBucket(), r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! } },
    services: {},
    config: { siteOrigin: "https://registry.test", securityAddress: "security@registry.test" },
  };
  db.exec(`insert into scopes (id, name, kind, state, created_at) values ('s', 'acme', 'org', 'active', '${AT}')`);
  return { fakes, d1, db, runtime };
}

/** Runs `job` against `limit` queries and returns how many it used, and the widest statement it bound. */
async function measure(runtime: AdminRuntime, job: CronJob, limit = Number.POSITIVE_INFINITY) {
  let widest = 0;
  const spy = {
    query: (sql: string, params: unknown[] = []) => (widest = Math.max(widest, params.length), runtime.ports.d1.query(sql, params)),
    batch: (statements: Array<{ sql: string; params?: unknown[] }>) => (statements.forEach((s) => (widest = Math.max(widest, s.params?.length ?? 0))), runtime.ports.d1.batch(statements)),
  };
  const budget = queryBudget(spy, limit);
  const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await job({ ...runtime, ports: { ...runtime.ports, d1: budget.d1 }, budget }).catch((e: unknown) => {
      if (!(e instanceof BudgetExhausted)) throw e;
    });
  } finally {
    quiet.mockRestore();
  }
  return { used: budget.used(), widest };
}

function seedPacks(f: ReturnType<typeof fixture>, count: number) {
  const insertPack = f.db.prepare("insert into packs (id, scope_id, name, visibility, created_at) values (?, 's', ?, 'public', ?)");
  for (let i = 0; i < count; i++) insertPack.run(`p${i}`, `x${i}`, AT);
}

describe("the share of D1 queries each cron job is held to", () => {
  it("rollup: a two-job backlog of full runs needs more than one invocation, and stops cleanly at its share", async () => {
    const f = fixture();
    seedPacks(f, 5);
    const day = new Date(f.fakes.clock.now()).toISOString();
    const line = (i: number) => JSON.stringify({ ClientRequestPath: `/@acme/x${i % 5}/1.0.0/pack.tar.zst`, ClientRequestMethod: "GET", EdgeResponseStatus: 200, EdgeStartTimestamp: day, ClientNetwork: `198.51.${i % 200}.0/24` });
    for (const job of ["hits", "misses"]) {
      for (let i = 0; i < 200; i++) await f.fakes.r2["OPS_BUCKET"]!.put(`logs/http-requests/${job}/${day.slice(0, 10).replaceAll("-", "")}/${String(i).padStart(4, "0")}.log`, new TextEncoder().encode(line(i)));
    }
    const unbounded = await measure(f.runtime, rollup);
    expect(unbounded.widest).toBeLessThanOrEqual(D1_PARAMS_PER_STATEMENT);
    expect(unbounded.used).toBeGreaterThan(JOB_QUERIES.get(rollup)!);

    // Start over: a bounded run stops, and the runs after it finish the backlog without counting anything twice.
    const g = fixture();
    seedPacks(g, 5);
    for (const key of await f.fakes.r2["OPS_BUCKET"]!.list("logs/")) await g.fakes.r2["OPS_BUCKET"]!.put(key, (await f.fakes.r2["OPS_BUCKET"]!.get(key))!);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCron(CRON_ROLLUP, g.runtime);
    expect(log.mock.calls.some(([l]) => String(l).includes("cron.budget_stopped"))).toBe(true);
    for (let i = 0; i < 4; i++) await runCron(CRON_ROLLUP, g.runtime);
    log.mockRestore();
    expect(g.db.prepare("select count(*) as n from rollup_files").get()).toEqual({ n: 400 });
    expect(f.db.prepare("select sum(weight) as w from fetch_days").get()).toEqual(g.db.prepare("select sum(weight) as w from fetch_days").get());
  });

  it("community: a catalogue of 1500 packs with a full notice queue", async () => {
    const f = fixture();
    seedPacks(f, 1500);
    f.db.exec(`insert into users (id, created_at) values ('u', '${AT}'); insert into user_emails (user_id, address, source, created_at) values ('u', 'u@example.test', 'github', '${AT}')`);
    const star = f.db.prepare("insert into stars (pack_id, user_id, created_at) values (?, 'u', ?)");
    for (let i = 0; i < 1500; i++) star.run(`p${i}`, AT);
    const notice = f.db.prepare("insert into community_notices (id, kind, user_id, data, created_at) values (?, 'review-removed', 'u', ?, ?)");
    for (let i = 0; i < 60; i++) notice.run(`n${i}`, JSON.stringify({ pack: "@acme/x", reason: "r", packPath: "/packs/x" }), AT);
    const m = await measure(f.runtime, community);
    expect(m.widest).toBeLessThanOrEqual(D1_PARAMS_PER_STATEMENT);
    expect(m.used).toBeLessThanOrEqual(JOB_QUERIES.get(community)!);
  });

  it("community: 2500 packs outgrow one recompute, and every pack is rewritten across the runs", async () => {
    const f = fixture();
    seedPacks(f, 2500);
    f.db.exec(`insert into users (id, created_at) values ('u', '2020-01-01T00:00:00.000Z')`);
    const star = f.db.prepare("insert into stars (pack_id, user_id, created_at) values (?, 'u', ?)");
    for (let i = 0; i < 2500; i++) star.run(`p${i}`, AT);
    const done = () => (f.db.prepare("select count(*) as n from pack_stats where stars = 1").get() as { n: number }).n;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await community(f.runtime);
    expect(done()).toBe(RECOMPUTE_PACKS_PER_RUN);
    await community(f.runtime);
    await community(f.runtime);
    log.mockRestore();
    expect(done()).toBe(2500);
    expect(f.db.prepare("select value from community_state where key = 'recompute_cursor'").get()).toBeUndefined();
  });

  it("lifecycle: 200 notices to 200 people", async () => {
    const f = fixture();
    seedPacks(f, 1);
    for (let i = 0; i < 200; i++) {
      f.db.exec(`insert into users (id, created_at) values ('m${i}', '${AT}');
        insert into user_emails (user_id, address, source, created_at) values ('m${i}', 'm${i}@example.test', 'github', '${AT}');
        insert into lifecycle_notices (id, user_id, pack_id, version, action, reason, audience, created_at) values ('n${i}', 'm${i}', 'p0', '1.0.0', 'yanked', 'r', 'stargazer', '${AT}')`);
    }
    const m = await measure(f.runtime, lifecycle);
    expect(m.widest).toBeLessThanOrEqual(D1_PARAMS_PER_STATEMENT);
    expect(m.used).toBeLessThanOrEqual(JOB_QUERIES.get(lifecycle)!);
    expect(f.db.prepare("select count(*) as n from lifecycle_notices where sent_at is null").get()).toEqual({ n: 0 });
  });

  it("lifecycle: a stop never leaves a mailed digest unmarked, so the next run mails nobody twice", async () => {
    const f = fixture();
    seedPacks(f, 1);
    for (let i = 0; i < 40; i++) {
      f.db.exec(`insert into users (id, created_at) values ('m${i}', '${AT}');
        insert into user_emails (user_id, address, source, created_at) values ('m${i}', 'm${i}@example.test', 'github', '${AT}');
        insert into lifecycle_notices (id, user_id, pack_id, version, action, reason, audience, created_at) values ('n${i}', 'm${i}', 'p0', '1.0.0', 'yanked', 'r', 'stargazer', '${AT}')`);
    }
    const sends: string[] = [];
    const mail = { send: async (m: { to: string }) => void sends.push(m.to) };
    const runtime = { ...f.runtime, ports: { ...f.runtime.ports, mail: mail as never } };
    for (const limit of [10, 17, 1000]) await measure(runtime, lifecycle, limit);
    expect(sends).toHaveLength(40);
    expect(new Set(sends).size).toBe(40);
  });

  it("moderation: a full sweep of 50 counter-noticed copyright removals outgrows its share, stops cleanly and finishes over the next runs", async () => {
    const seed = async () => {
      const f = fixture();
      f.db.exec(`insert into users (id, handle, created_at) values ('own', 'own', '${AT}');
        insert into scope_members (scope_id, user_id, role, created_at) values ('s', 'own', 'owner', '${AT}')`);
      seedPacks(f, 1);
      const insertVersion = f.db.prepare("insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values (?, 'p0', ?, 'active', ?, 1, ?, 0, 0)");
      for (let i = 0; i < 50; i++) insertVersion.run(`v${i}`, `1.0.${i}`, "0".repeat(64), AT);
      const ops = opsPorts(f.runtime).moderation;
      for (let i = 0; i < 50; i++) {
        const removed = await removeOnCopyrightNotice(ops, "admin@example.test", { pack: "@acme/x0", version: `1.0.${i}`, complainant: "c@claim.test" });
        if (!removed.ok) throw new Error(removed.message);
        await fileCounterNotice(ops, removed.action_id, "own", "mine");
      }
      f.fakes.clock.advance("40d");
      return f;
    };
    const restored = (f: Awaited<ReturnType<typeof seed>>) => f.db.prepare("select count(*) as n from dmca_cases where state = 'restored'").get();
    const whole = await seed();
    const m = await measure(whole.runtime, moderation);
    expect(m.widest).toBeLessThanOrEqual(D1_PARAMS_PER_STATEMENT);
    expect(m.used).toBeGreaterThan(JOB_QUERIES.get(moderation)!);
    expect(restored(whole)).toEqual({ n: 50 });

    // Wherever a stop lands, a case is restored together with its version and its action, never alone.
    for (const limit of [13, 20, 31, JOB_QUERIES.get(moderation)!]) {
      const f = await seed();
      for (let run = 0; run < 60 && (restored(f) as { n: number }).n < 50; run++) {
        await measure(f.runtime, moderation, limit);
        expect(f.db.prepare("select count(*) as n from dmca_cases where state = 'restored'").get()).toEqual(f.db.prepare("select count(*) as n from pack_versions where state = 'active'").get());
        expect(f.db.prepare("select count(*) as n from moderation_actions where restored_at is not null").get()).toEqual(f.db.prepare("select count(*) as n from dmca_cases where state = 'restored'").get());
      }
      expect(restored(f)).toEqual({ n: 50 });
      expect(f.db.prepare("select count(*) as n from pack_versions where state = 'active'").get()).toEqual({ n: 50 });
    }
  });

  it("github proof lapse: 80 App-proven organisations, each needing a repair", async () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) {
      f.db.exec(`insert into scopes (id, name, kind, state, created_at) values ('o${i}', 'org${i}', 'org', 'active', '${AT}');
        insert into github_org_proofs (scope_id, org_id, org_login, method, installation_id, proven_at, alerted_at) values ('o${i}', '${1000 + i}', 'org${i}', 'app', ${i}, '${AT}', '${AT}');
        insert into github_installations (installation_id, account_id, account_login, account_type, sender_login, repository_selection, status, installed_at, updated_at) values (${5000 + i}, ${1000 + i}, 'org${i}', 'Organization', 's', 'all', 'active', '${AT}', '${AT}')`);
    }
    const m = await measure(f.runtime, githubProofLapse);
    expect(m.used).toBe(2 + 2 * 80);
    expect(m.used).toBeLessThanOrEqual(JOB_QUERIES.get(githubProofLapse)!);
  });

  it("github proof lapse: a list longer than one share is reached whole across runs, wrapping round at the end", async () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) {
      f.db.exec(`insert into scopes (id, name, kind, state, created_at) values ('o${String(i).padStart(2, "0")}', 'org${i}', 'org', 'active', '${AT}');
        insert into github_org_proofs (scope_id, org_id, org_login, method, installation_id, proven_at, alerted_at) values ('o${String(i).padStart(2, "0")}', '${1000 + i}', 'org${i}', 'app', ${i}, '${AT}', '${AT}');
        insert into github_installations (installation_id, account_id, account_login, account_type, sender_login, repository_selection, status, installed_at, updated_at) values (${5000 + i}, ${1000 + i}, 'org${i}', 'Organization', 's', 'all', 'active', '${AT}', '${AT}')`);
    }
    const pending = () => (f.db.prepare("select count(*) as n from github_org_proofs where alerted_at is not null").get() as { n: number }).n;
    const cursor = () => f.db.prepare("select value from community_state where key = 'github_proof_lapse_cursor'").get();
    let runs = 0;
    while (pending() > 0 && runs < 20) {
      await measure(f.runtime, githubProofLapse, 60);
      runs++;
      if (pending() > 0) expect(cursor()).toBeDefined();
    }
    expect(pending()).toBe(0);
    expect(runs).toBeGreaterThan(1);
    // The run that reaches the end forgets the place, so the next one starts from the top.
    await measure(f.runtime, githubProofLapse, 100);
    expect(cursor()).toBeUndefined();
  });

  it("synthetic expiry: one read and one batch however many versions are due", async () => {
    const f = fixture();
    expect((await measure(f.runtime, syntheticExpiry)).used).toBeLessThanOrEqual(2);
    expect(JOB_QUERIES.get(syntheticExpiry)).toBeGreaterThanOrEqual(2);
  });

  it("report notices: 200 queued notices", async () => {
    const f = fixture();
    seedPacks(f, 1);
    const queue = f.db.prepare("insert into report_notices (id, kind, recipient, data, created_at) values (?, 'security-report-update', 'registry-security', ?, ?)");
    for (let i = 0; i < 200; i++) queue.run(`r${i}`, JSON.stringify({ reportUrl: "/r/1", pack: "@acme/x0", version: "1.0.0", status: "open", summary: "s" }), AT);
    const m = await measure(f.runtime, reportNotices);
    expect(m.widest).toBeLessThanOrEqual(D1_PARAMS_PER_STATEMENT);
    expect(m.used).toBeLessThanOrEqual(JOB_QUERIES.get(reportNotices)!);
  });
});

describe("the budget of a trigger", () => {
  it.each(Object.entries(CRON_JOBS))("%s: the jobs' shares fit one invocation", (cron, jobs) => {
    const total = jobs.reduce((sum, job) => sum + (JOB_QUERIES.get(job) ?? 0), 0);
    if (cron === "0 3 * * *") return;
    expect(total).toBeLessThanOrEqual(INVOCATION_QUERIES);
  });

  it("every hourly-or-sooner job has a share, and the rollup and the report notices each have a trigger of their own", () => {
    for (const cron of [CRON_HOURLY, CRON_ROLLUP, CRON_REPORTS]) for (const job of CRON_JOBS[cron]!) expect(JOB_QUERIES.has(job)).toBe(true);
    expect(CRON_JOBS[CRON_ROLLUP]).toEqual([rollup]);
    expect(CRON_JOBS[CRON_REPORTS]).toEqual([reportNotices]);
  });

  it("refuses the query past the share and counts a batch as one", async () => {
    const f = fixture();
    const budget = queryBudget(f.d1, 2);
    await budget.d1.batch([{ sql: "select 1" }, { sql: "select 2" }, { sql: "select 3" }]);
    expect(budget.used()).toBe(1);
    await budget.d1.query("select 1");
    expect(budget.hasRoom(1)).toBe(false);
    await expect(budget.d1.query("select 1")).rejects.toThrow("share of 2");
  });
});
