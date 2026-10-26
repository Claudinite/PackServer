import { LATENCY_BOUNDS_MS } from "@packserver/core/gates";
import { REQUEST_BLOBS, REQUEST_DOUBLES } from "@packserver/core/telemetry";
import { describe, expect, it } from "vitest";
import { analyticsGateData, domainEventsSql, requestOutcomesSql, ROW_LIMIT, syntheticProbesSql } from "../src/stats/sql";
import { windowAt } from "../src/stats/source";

const window = windowAt(Date.UTC(2026, 9, 22, 12, 30, 0));

describe("the reads", () => {
  it("name the recorder's columns by position", () => {
    const sql = requestOutcomesSql("request_outcomes", window);
    expect(sql).toContain(`blob${REQUEST_BLOBS.indexOf("outcome") + 1} IN ('server_error', 'exception', 'canceled')`);
    expect(sql).toContain(`double${REQUEST_DOUBLES.indexOf("is_synthetic") + 1} AS is_synthetic`);
    expect(sql).toContain("index1 AS version_id");
    for (let i = 0; i <= LATENCY_BOUNDS_MS.length; i++) expect(sql).toContain(`AS h${i}`);
  });

  it("bound the window and exclude unknown durations from the histogram", () => {
    const sql = requestOutcomesSql("request_outcomes", window);
    expect(sql).toContain(`timestamp >= toDateTime(${Math.floor(window.sinceMs / 1000)})`);
    expect(sql).toContain(`double${REQUEST_DOUBLES.indexOf("duration_ms") + 1} >= 0`);
  });

  it("select only the signals the gates read", () => {
    const sql = domainEventsSql("domain_events", window);
    expect(sql).toContain("'selftest.result'");
    expect(sql).not.toContain("'http.request'");
    expect(syntheticProbesSql("synthetic_probes", window)).toContain("index1 = 'synthetic.probe'");
  });
});

describe("the Analytics Engine client", () => {
  const respond = (data: unknown[], init: ResponseInit = {}) => (async () => new Response(JSON.stringify({ data }), init)) as unknown as typeof fetch;
  const config = { accountId: async () => "acct", token: async () => "tok", datasetSuffix: "_staging" };

  it("posts the statement to the account's SQL endpoint with the read token, against the suffixed dataset", async () => {
    const seen: Array<{ url: string; auth: string | null; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: String(init.body) });
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    await analyticsGateData(config, fetchImpl).requestOutcomes(window);
    expect(seen[0]).toMatchObject({ url: "https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql", auth: "Bearer tok" });
    expect(seen[0]?.body).toContain("FROM request_outcomes_staging");
  });

  it("parses rows into numbers, booleans and a histogram", async () => {
    const row = { version_id: "v", worker: "web", version_override: "0", is_synthetic: 1, principal: "p", ip: "", samples: "10", bad: 1, downloads: 0, today: 10, recent: 5, h2: "9", h16: 1 };
    const [group] = await analyticsGateData(config, respond([row])).requestOutcomes(window);
    expect(group).toMatchObject({ version_id: "v", override: false, synthetic: true, samples: 10, bad: 1 });
    expect(group?.latency).toHaveLength(LATENCY_BOUNDS_MS.length + 1);
    expect(group?.latency[2]).toBe(9);
    expect(group?.latency[LATENCY_BOUNDS_MS.length]).toBe(1);
  });

  it("turns seconds into milliseconds for the domain and probe reads", async () => {
    const [d] = await analyticsGateData(config, respond([{ signal: "queue.backlog", version_id: "v", attrs: "{}", n: 1, recent: 1, ts: 100, d1: 1, d2: 2 }])).domainEvents(window);
    expect(d?.ts).toBe(100_000);
    const [p] = await analyticsGateData(config, respond([{ attrs: "{}", n: 1, ts: 7 }])).syntheticProbes(window);
    expect(p?.ts).toBe(7000);
  });

  it("refuses a read that filled the row limit rather than judging half the data", async () => {
    const full = Array.from({ length: ROW_LIMIT }, () => ({ attrs: "{}", n: 1, ts: 1 }));
    await expect(analyticsGateData(config, respond(full)).syntheticProbes(window)).rejects.toThrow(/incomplete/);
  });

  it("surfaces an API failure and a body with no data", async () => {
    await expect(analyticsGateData(config, (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch).requestOutcomes(window)).rejects.toThrow(/403/);
    await expect(analyticsGateData(config, (async () => new Response("{}")) as unknown as typeof fetch).requestOutcomes(window)).rejects.toThrow(/without data/);
  });
});
