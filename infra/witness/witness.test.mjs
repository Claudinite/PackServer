import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyHook } from "../../packages/core/alerts/hook-signature.ts";
import { BOT_LOGIN, HEARTBEAT_SIGNAL, HOOK_URL, PUSHOVER_URL, heartbeatSql, heartbeatState, run, signReport, siteFailures } from "./scripts/witness-report.mjs";

const NOW = Date.parse("2026-11-01T10:30:00Z");
const MIN = 60_000;
const env = { GITHUB_REPOSITORY: "Claudinite/packserver-witness", GITHUB_TOKEN: "gh", WITNESS_HOOK_SECRET: "hook-secret", CF_ACCOUNT_ID: "acct", CF_ANALYTICS_READ_TOKEN: "cf", PUSHOVER_APP_TOKEN: "app", PUSHOVER_USER_KEY: "user" };
const downIssue = (slug, ageMs) => ({ title: "\u{1F6D1} Registry is down", labels: [{ name: "status" }, { name: slug }], created_at: new Date(NOW - ageMs).toISOString() });

/** A fake network: the GitHub issue list, the Analytics Engine answer and the router's status; records every call. */
function network({ issues = [], heartbeat = { fresh: 3 }, heartbeatData, router = 202, heartbeatStatus = 200, pushover = 200, records = [], comments = [], labelStatus = 201 }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const respond = (status, body) => new Response(JSON.stringify(body), { status });
    const u = String(url);
    if (u.includes("/issues?") && u.includes("labels=witness-push")) return respond(200, records);
    if (u.includes("/comments?")) return respond(200, comments);
    if (u.endsWith("/labels")) return respond(labelStatus, {});
    if (u.endsWith("/lock")) return new Response(null, { status: 204 });
    if (init.method === "POST" && u.endsWith("/issues")) return respond(201, { number: 9 });
    if (u.includes("/issues?")) return respond(200, issues);
    if (u.includes("/comments")) return respond(201, {});
    if (u.includes("analytics_engine/sql")) return respond(heartbeatStatus, { data: heartbeatData ?? [heartbeat] });
    if (url === HOOK_URL) return respond(router, {});
    if (url === PUSHOVER_URL) return respond(pushover, {});
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}
const record = (kind, createdAgoMs = 24 * 60 * MIN, user = BOT_LOGIN) => ({ number: 7, title: kind, created_at: new Date(NOW - createdAgoMs).toISOString(), user: { login: user } });
const comment = (ageMs, user = BOT_LOGIN) => ({ user: { login: user }, created_at: new Date(NOW - ageMs).toISOString() });
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
  it("is dead on a real zero count, and unchecked on anything else", () => {
    expect(heartbeatState({ data: [{ fresh: "0" }] })).toEqual({ alive: false });
    expect(heartbeatState({ data: [{ fresh: 4 }] })).toEqual({ alive: true });
    expect(() => heartbeatState({ data: [] })).toThrow();
    expect(() => heartbeatState({ data: [{ fresh: "x" }] })).toThrow();
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

  it("does not push directly for a first failed probe, the router's own rule", async () => {
    const { pushes } = await go(network({ issues: [downIssue("registry", 20_000)], router: 503 }));
    expect(pushes).toHaveLength(0);
  });

  it("reports a missing judge heartbeat as the dead man's switch", async () => {
    const { router, pushes } = await go(network({ heartbeat: { fresh: 0 } }));
    expect(router.map((c) => JSON.parse(c.init.body))).toEqual([{ check: "judge_heartbeat", status: "down" }]);
    expect(pushes).toHaveLength(0);
  });

  it("falls back to Pushover when the router refuses, and records the push", async () => {
    const net = network({ heartbeat: { fresh: 0 }, router: 503 });
    const { pushes } = await go(net);
    expect(pushes).toHaveLength(1);
    const body = new URLSearchParams(pushes[0].init.body.toString());
    expect([body.get("token"), body.get("user"), body.get("priority")]).toEqual(["app", "user", "1"]);
    const created = net.calls.find((c) => c.url.endsWith("/issues") && c.init.method === "POST");
    expect(JSON.parse(created.init.body)).toMatchObject({ title: "judge_heartbeat", labels: ["witness-push"] });
  });

  it("holds the next push back until an hour after the bot's last comment, however many runs were skipped", async () => {
    const recent = await go(network({ heartbeat: { fresh: 0 }, router: 503, records: [record("judge_heartbeat")], comments: [comment(59 * MIN)] }));
    expect(recent.pushes).toHaveLength(0);
    const due = network({ heartbeat: { fresh: 0 }, router: 503, records: [record("judge_heartbeat")], comments: [comment(61 * MIN)] });
    expect((await go(due)).pushes).toHaveLength(1);
    expect(due.calls.some((c) => c.url.endsWith("/issues/7/comments") && c.init.method === "POST")).toBe(true);
  });

  it("is not moved by a comment from anyone else, nor by a record someone else opened", async () => {
    const stranger = await go(network({ heartbeat: { fresh: 0 }, router: 503, records: [record("judge_heartbeat")], comments: [comment(61 * MIN), comment(MIN, "stranger")] }));
    expect(stranger.pushes).toHaveLength(1);
    const forged = network({ heartbeat: { fresh: 0 }, router: 503, records: [record("judge_heartbeat", MIN, "stranger")] });
    expect((await go(forged)).pushes).toHaveLength(1);
    expect(forged.calls.some((c) => c.url.endsWith("/issues/7/comments") && c.init.method === "POST")).toBe(false);
  });

  it("creates its label when missing and locks the record it opens", async () => {
    const net = network({ heartbeat: { fresh: 0 }, router: 503, labelStatus: 422 });
    await go(net);
    expect(net.calls.some((c) => c.url.endsWith("/labels"))).toBe(true);
    expect(net.calls.some((c) => c.url.endsWith("/issues/9/lock") && c.init.method === "PUT")).toBe(true);
  });

  it("does not push directly when the router took the report", async () => {
    const { pushes } = await go(network({ heartbeat: { fresh: 0 } }));
    expect(pushes).toHaveLength(0);
  });

  it.each([
    ["a revoked token", { heartbeatStatus: 403 }],
    ["a query with no row", { heartbeatData: [] }],
  ])("tells Ariel it cannot check the judge on %s, and never reports the judge down", async (_, options) => {
    const { failures, router, pushes } = await go(network(options));
    expect(failures).toHaveLength(1);
    expect(router).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(new URLSearchParams(pushes[0].init.body.toString()).get("title")).toBe("Witness cannot check the judge");
    expect(new URLSearchParams(pushes[0].init.body.toString()).get("priority")).toBe("0");
  });

  it("throttles the cannot-check push like any other", async () => {
    const { pushes } = await go(network({ heartbeatStatus: 403, records: [record("judge_unchecked")], comments: [comment(10 * MIN)] }));
    expect(pushes).toHaveLength(0);
  });

  it("still reports the sites when the heartbeat read fails", async () => {
    const { failures, router } = await go(network({ issues: [downIssue("registry", 6 * MIN)], heartbeatStatus: 500 }));
    expect(failures).toHaveLength(1);
    expect(router).toHaveLength(1);
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
    expect(config).not.toContain("publish:");
  });
  it("names every slug the reporter looks for", () => {
    for (const slug of ["registry", "index-root", "oauth-metadata"]) expect(config).toContain(`slug: ${slug}\n`);
  });
});
