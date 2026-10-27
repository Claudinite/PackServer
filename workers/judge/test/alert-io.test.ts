import { adminMethodsFor } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { BURN_WINDOWS_MS } from "@packserver/core/alerts";
import { cloudflarePlatform, parseQueueIds } from "../src/alerts/platform";
import { alertEventsSql, analyticsAlertData, burnSql, ratesSql } from "../src/alerts/read";
import { createApp } from "../src/app";
import { createRuntime, parseSupportHours, type Env } from "../src/bindings";
import { PUSHOVER_URL, pushoverPager } from "../src/router/pushover";
import { JUDGE_METHODS } from "../src/safe-actions/run";
import { runScheduled } from "../src/gates/scheduled";
import { dummyEnv } from "@packserver/http/testing";
import { alertHarness, row, toHour } from "./alert-support";
import { FakeGateData, runtimeWith, judgeFakes } from "./support";
import { signalEmitter } from "../src/heartbeat/emit";

describe("Pushover", () => {
  it("posts to the one recipient the configuration names, with the application token", async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const pager = pushoverPager({ token: async () => "app-token", user: async () => "ariel" }, (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as URLSearchParams });
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    await pager.send({ title: "t", message: "m", url: "https://admin.example/ops", urlTitle: "Ops", priority: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(PUSHOVER_URL);
    expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({ token: "app-token", user: "ariel", title: "t", message: "m", priority: "1", url: "https://admin.example/ops", url_title: "Ops" });
  });
  it("fails on a refusal", async () => {
    const pager = pushoverPager({ token: async () => "a", user: async () => "u" }, (async () => new Response("{}", { status: 400 })) as typeof fetch);
    await expect(pager.send({ title: "t", message: "m", url: "", urlTitle: "", priority: 0 })).rejects.toThrow("Pushover answered 400");
  });
});

describe("the judge's method set", () => {
  it("is REQ-ADMIN-010's four methods and the admin API's table agrees", () => {
    expect([...JUDGE_METHODS].sort()).toEqual(["acknowledge_page", "enable_new_pack_kill_switch", "quarantine_version", "set_telemetry_mode"]);
    expect(adminMethodsFor("judge").sort()).toEqual([...JUDGE_METHODS].sort());
  });
});

describe("Cloudflare polling", () => {
  const json = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  it("reads each queue's metrics and turns the oldest timestamp into an age; an empty queue is age 0, an unstated one unknown", async () => {
    const seen: string[] = [];
    const platform = cloudflarePlatform({ accountId: async () => "acct", zoneId: "z", token: async () => "tok", queueIds: { audit: "q1", validation: "q2", reindex: "q3" } }, (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      if (String(url).endsWith("q1/metrics")) return json({ backlog_count: 3, oldest_message_timestamp_ms: 1_000_000 - 90_000 });
      if (String(url).endsWith("q2/metrics")) return json({ backlog_count: 0, oldest_message_timestamp_ms: 0 });
      return json({ backlog_count: 5 });
    }) as typeof fetch);
    expect(await platform.queueBacklogs(1_000_000)).toEqual([
      { queue: "audit", depth: 3, oldestAgeS: 90 },
      { queue: "validation", depth: 0, oldestAgeS: 0 },
      { queue: "reindex", depth: 5, oldestAgeS: null },
    ]);
    expect(seen[0]).toBe("https://api.cloudflare.com/client/v4/accounts/acct/queues/q1/metrics");
  });
  it("counts Logpush jobs whose last error is newer than their last success", async () => {
    const platform = cloudflarePlatform({ accountId: async () => "a", zoneId: "z1", token: async () => "t", queueIds: {} }, (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("https://api.cloudflare.com/client/v4/zones/z1/logpush/jobs");
      return json([
        { id: 1, last_complete: "2026-10-27T10:00:00Z", last_error: null },
        { id: 2, last_complete: "2026-10-27T10:00:00Z", last_error: "2026-10-27T11:00:00Z" },
        { id: 3, last_complete: "2026-10-27T12:00:00Z", last_error: "2026-10-27T11:00:00Z" },
        { id: 4, last_complete: null, last_error: "2026-10-27T11:00:00Z" },
      ]);
    }) as typeof fetch);
    expect(await platform.failingLogpushJobs()).toBe(2);
  });
  it("reads a script's bindings back, with the secret each points at", async () => {
    const platform = cloudflarePlatform({ accountId: async () => "acct", zoneId: undefined, token: async () => "t", queueIds: {} }, (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/web/settings");
      return json({ bindings: [{ name: "KV", type: "kv_namespace" }, { name: "SIGNING_KEY_ACTIVE", type: "secrets_store_secret", store_id: "s", secret_name: "signing-key" }, { type: "broken" }] });
    }) as typeof fetch);
    expect(await platform.scriptBindings("web")).toEqual([{ name: "KV", secretName: null }, { name: "SIGNING_KEY_ACTIVE", secretName: "signing-key" }]);
    const empty = cloudflarePlatform({ accountId: async () => "a", zoneId: undefined, token: async () => "t", queueIds: {} }, (async () => json({})) as typeof fetch);
    await expect(empty.scriptBindings("web")).rejects.toThrow("no bindings list");
  });
  it("polls nothing, and says nothing, for a queue list or zone that is not configured", async () => {
    const platform = cloudflarePlatform({ accountId: async () => "a", zoneId: undefined, token: async () => "t", queueIds: {} }, (async () => { throw new Error("no call expected"); }) as typeof fetch);
    expect(await platform.queueBacklogs(0)).toEqual([]);
    expect(await platform.failingLogpushJobs()).toBeNull();
  });
  it("is an error, not a zero, when the API refuses", async () => {
    const platform = cloudflarePlatform({ accountId: async () => "a", zoneId: "z", token: async () => "t", queueIds: { q: "1" } }, (async () => new Response("no", { status: 403 })) as typeof fetch);
    await expect(platform.queueBacklogs(0)).rejects.toThrow("403");
    await expect(platform.failingLogpushJobs()).rejects.toThrow("403");
  });
  it("parses queue ids", () => {
    expect(parseQueueIds("audit:q1, validation:q2,,bad")).toEqual({ audit: "q1", validation: "q2" });
    expect(parseQueueIds("")).toEqual({});
  });
});

describe("the alert reads", () => {
  it("asks for every window the detectors use in one statement each", () => {
    const now = 1_800_000_000_000;
    expect(alertEventsSql("domain_events", now)).toContain("index1 IN ('download.hash_mismatch'");
    expect(ratesSql("domain_events", now)).toContain("'publish.received'");
    const burn = burnSql("request_outcomes", now);
    for (let i = 0; i < BURN_WINDOWS_MS.length; i++) expect(burn).toContain(`AS t${i}`);
    expect(burn).toContain("IN ('web', 'mcp')");
  });
  it("refuses a truncated read instead of judging it", async () => {
    const source = analyticsAlertData({ accountId: async () => "a", token: async () => "t", datasetSuffix: "_test" }, (async () => new Response(JSON.stringify({ data: Array.from({ length: 10_000 }, () => ({})) }))) as typeof fetch);
    await expect(source.events(0)).rejects.toThrow("incomplete");
  });
  it("reads rows into numbers", async () => {
    const source = analyticsAlertData({ accountId: async () => "a", token: async () => "t", datasetSuffix: "" }, (async () => new Response(JSON.stringify({ data: [{ signal: "x", attrs: "{}", n30m: "2", n1h: 3, n24h: 4, ts: 5, d1: 6, d2: -1 }] }))) as typeof fetch);
    expect(await source.events(0)).toEqual([{ signal: "x", attrs: "{}", n30m: 2, n1h: 3, n24h: 4, ts: 5000, d1: 6, d2: -1 }]);
  });
});

describe("configuration", () => {
  it("parses the support window and refuses nonsense", () => {
    expect(parseSupportHours("7-19")).toEqual({ startHour: 7, endHour: 19 });
    for (const bad of ["", "19-7", "7", "a-b", "0-25"]) expect(parseSupportHours(bad)).toBeNull();
  });
  it("builds no alerting, and says what is missing, when a setting is absent", () => {
    const built = createRuntime(dummyEnv("judge") as unknown as Env);
    expect(built.config.alerts).toBeNull();
    expect(built.config.alertsMissing).toEqual(["MAIL_FROM", "OPS_EMAIL", "OPS_PAGE_URL", "PUBLIC_ORIGIN", "SUPPORT_HOURS_UTC"]);
  });
  it("builds alerting when the settings are there", () => {
    const env = { ...dummyEnv("judge"), MAIL_FROM: "n@x", OPS_EMAIL: "ops@x", OPS_PAGE_URL: "https://a/ops", PUBLIC_ORIGIN: "https://r", SUPPORT_HOURS_UTC: "7-19" };
    const built = createRuntime(env as unknown as Env);
    expect(built.config.alertsMissing).toEqual([]);
    expect(built.config.alerts?.window).toEqual({ startHour: 7, endHour: 19 });
    expect(built.config.alerts?.platform).toBeDefined();
  });
  it("answers 503 on the hook paths when alerting is not configured", async () => {
    const app = createApp(runtimeWith(judgeFakes()));
    const res = await app.request("/hooks/monitors", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "alerts_unconfigured" });
  });
});

describe("the cron with alerting", () => {
  it("runs the alert half after the gates and reports a missing configuration as a failed cycle", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.fakes.clock.advance("5m");
    h.data.rows = [row("index.key_changed", { key_id: "x" })];
    const deps = {
      clock: h.fakes.clock,
      gatesKv: h.fakes.kv["GATES_KV"] as never,
      telemetryKv: h.fakes.kv["TELEMETRY_KV"] as never,
      data: new FakeGateData(),
      stats: h.fakes.stats,
      admin: h.admin,
      emit: signalEmitter({ releaseId: "rel", versionId: "judge-1", clock: h.fakes.clock, stats: h.fakes.stats, telemetry: h.fakes.telemetry }),
      ciTokenIds: [],
      dailyLogAllowance: 1000,
      alerts: { data: h.data, router: h.router, dispatcher: h.dispatcher, store: h.store, pager: h.pager, opsPageUrl: "https://a/ops" },
    };
    const first = await runScheduled(deps);
    expect(first.failures).toEqual([]);
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.index_key_changed (RB-06)"]);
    expect(h.signals("budget.usage")).toHaveLength(1);

    const missing = alertHarness();
    toHour(missing.fakes.clock, 12);
    await expect(runScheduled({ ...deps, clock: missing.fakes.clock, alerts: undefined, alertsMissing: ["OPS_EMAIL"] })).rejects.toThrow("1 judge steps failed");
  });
});

