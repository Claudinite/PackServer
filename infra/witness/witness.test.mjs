import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyHook } from "../../packages/core/alerts/hook-signature.ts";
import { HEARTBEAT_SIGNAL, HOOK_URL, PUSHOVER_URL, directPushDue, heartbeatSql, heartbeatState, run, signReport, siteFailures } from "./scripts/witness-report.mjs";

const NOW = Date.parse("2026-11-01T10:30:00Z");
const MIN = 60_000;
const env = { GITHUB_REPOSITORY: "Claudinite/packserver-witness", GITHUB_TOKEN: "gh", WITNESS_HOOK_SECRET: "hook-secret", CF_ACCOUNT_ID: "acct", CF_ANALYTICS_READ_TOKEN: "cf", PUSHOVER_APP_TOKEN: "app", PUSHOVER_USER_KEY: "user" };
const downIssue = (slug, ageMs) => ({ title: "\u{1F6D1} Registry is down", labels: [{ name: "status" }, { name: slug }], created_at: new Date(NOW - ageMs).toISOString() });

/** A fake network: the GitHub issue list, the Analytics Engine answer and the router's status; records every call. */
function network({ issues = [], heartbeat = { fresh: 3, recent: 3 }, router = 202, heartbeatStatus = 200, pushover = 200 }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const respond = (status, body) => new Response(JSON.stringify(body), { status });
    if (String(url).includes("/issues?")) return respond(200, issues);
    if (String(url).includes("analytics_engine/sql")) return respond(heartbeatStatus, { data: [heartbeat] });
    if (url === HOOK_URL) return respond(router, {});
    if (url === PUSHOVER_URL) return respond(pushover, {});
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}
const go = async (net, at = NOW) => {
  const log = [];
  const failures = await run({ env, fetchImpl: net.fetchImpl, nowMs: at, log: (l) => log.push(l) });
  return { failures, log, router: net.calls.filter((c) => c.url === HOOK_URL), pushes: net.calls.filter((c) => c.url === PUSHOVER_URL) };
};

describe("the signature", () => {
  it("is the one the router verifies", async () => {
    const body = JSON.stringify({ check: "judge_heartbeat", status: "down" });
    const header = signReport("s3", body, NOW);
    expect(await verifyHook("witness", { header: () => header, body }, "s3", NOW)).toEqual({ ok: true });
    expect(await verifyHook("witness", { header: () => header, body }, "other", NOW)).toMatchObject({ ok: false });
  });
});

describe("site failures", () => {
  it("counts cycles from the age of the open downtime issue, longest first", () => {
    expect(siteFailures([downIssue("registry", 20_000)], NOW)).toEqual({ down: ["registry"], consecutive: 1 });
    expect(siteFailures([downIssue("registry", 5 * MIN + 20_000), downIssue("index-root", 12 * MIN)], NOW).consecutive).toBe(3);
  });
  it("ignores degraded issues and issues for other labels", () => {
    const degraded = { ...downIssue("registry", 30 * MIN), title: "⚠️ Registry has degraded performance" };
    const other = { ...downIssue("something-else", 30 * MIN) };
    expect(siteFailures([degraded, other], NOW)).toEqual({ down: [], consecutive: 0 });
  });
});

describe("the heartbeat", () => {
  it("is read from the judge's domain events over the router's 15 minutes", () => {
    const sql = heartbeatSql(NOW);
    expect(sql).toContain(`index1 = '${HEARTBEAT_SIGNAL}'`);
    expect(sql).toContain(`toDateTime(${(NOW - 15 * MIN) / 1000})`);
  });
  it("is dead only on a real zero, never on a malformed answer", () => {
    expect(heartbeatState({ data: [{ fresh: "0", recent: "2" }] })).toEqual({ alive: false, justCrossed: true });
    expect(heartbeatState({ data: [{ fresh: 4, recent: 4 }] }).alive).toBe(true);
    expect(() => heartbeatState({ data: [] })).toThrow();
  });
});

describe("a report run", () => {
  it("sends nothing while everything is up", async () => {
    const { router, pushes, failures } = await go(network({}));
    expect([router.length, pushes.length, failures]).toEqual([0, 0, []]);
  });

  it("reports a site down with its failure count, signed", async () => {
    const { router, pushes } = await go(network({ issues: [downIssue("index-root", 5 * MIN + 10_000)] }));
    expect(router).toHaveLength(1);
    const { body, headers } = router[0].init;
    expect(JSON.parse(body)).toEqual({ check: "site", status: "down", consecutive_failures: 2 });
    expect(await verifyHook("witness", { header: (n) => headers[n], body }, env.WITNESS_HOOK_SECRET, NOW)).toEqual({ ok: true });
    expect(pushes).toHaveLength(0);
  });

  it("reports a missing judge heartbeat as the dead man's switch", async () => {
    const { router } = await go(network({ heartbeat: { fresh: 0, recent: 0 } }));
    expect(router.map((c) => JSON.parse(c.init.body))).toEqual([{ check: "judge_heartbeat", status: "down" }]);
  });

  it("falls back to Pushover on the first detection when the router refuses, then stays quiet until the hour", async () => {
    const first = await go(network({ heartbeat: { fresh: 0, recent: 1 }, router: 503 }));
    expect(first.pushes).toHaveLength(1);
    const body = new URLSearchParams(first.pushes[0].init.body.toString());
    expect([body.get("token"), body.get("user"), body.get("priority")]).toEqual(["app", "user", "1"]);

    const later = await go(network({ heartbeat: { fresh: 0, recent: 0 }, router: 503 }), Date.parse("2026-11-01T10:30:00Z"));
    expect(later.pushes).toHaveLength(0);
    const hourly = await go(network({ heartbeat: { fresh: 0, recent: 0 }, router: 503 }), Date.parse("2026-11-01T11:02:00Z"));
    expect(hourly.pushes).toHaveLength(1);
  });

  it("does not push directly when the router took the report", async () => {
    const { pushes } = await go(network({ heartbeat: { fresh: 0, recent: 1 } }));
    expect(pushes).toHaveLength(0);
  });

  it("fails the run, without a page, when the heartbeat cannot be read", async () => {
    const { failures, router, pushes } = await go(network({ heartbeatStatus: 403 }));
    expect(failures).toHaveLength(1);
    expect([router.length, pushes.length]).toEqual([0, 0]);
  });

  it("still reports the sites when the heartbeat read fails", async () => {
    const { failures, router } = await go(network({ issues: [downIssue("registry", 6 * MIN)], heartbeatStatus: 500 }));
    expect(failures).toHaveLength(1);
    expect(router).toHaveLength(1);
  });
});

describe("direct push throttle", () => {
  it("fires on first detection and in the first five minutes of an hour only", () => {
    expect(directPushDue({ first: true, nowMs: NOW })).toBe(true);
    expect(directPushDue({ first: false, nowMs: NOW })).toBe(false);
    expect(directPushDue({ first: false, nowMs: Date.parse("2026-11-01T11:04:00Z") })).toBe(true);
  });
});

describe("the Upptime configuration", () => {
  const config = readFileSync(join(import.meta.dirname, ".upptimerc.yml"), "utf8");
  it("probes the three endpoints every five minutes", () => {
    for (const url of ["https://registry.claudinite.com/", "https://packs.claudinite.com/index/v1/root.json", "https://registry.claudinite.com/.well-known/oauth-protected-resource/mcp"]) {
      expect(config).toContain(`url: ${url}\n`);
    }
    expect(config).toContain('uptime: "*/5 * * * *"');
    expect(config).toMatch(/index\/v1\/root\.json[\s\S]*__dangerous__body_down_if_text_missing: '"serial"'/);
  });
  it("sets no custom domain and no secrets of its own", () => {
    expect(config).not.toMatch(/^\s*cname:/m);
    expect(config).toMatch(/^secrets: \[\]$/m);
    expect(config).toContain("baseUrl: /packserver-witness");
  });
  it("names every slug the reporter looks for", () => {
    for (const slug of ["registry", "index-root", "oauth-metadata"]) expect(config).toContain(`slug: ${slug}\n`);
  });
});
