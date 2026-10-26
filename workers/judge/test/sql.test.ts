import { LATENCY_BOUNDS_MS } from "@packserver/core/gates";
import { REQUEST_BLOBS, REQUEST_DOUBLES } from "@packserver/core/telemetry";
import { describe, expect, it } from "vitest";
import { versionClientsSql, CANDIDATE_TOP, analyticsGateData, domainEventsSql, MIN_CLIENT_SAMPLES, requestOutcomesSql, ROW_LIMIT, syntheticProbesSql, TOP_CLIENTS, topClientsSql } from "../src/stats/sql";
import { windowAt } from "../src/stats/source";

const NOW = Date.UTC(2026, 9, 22, 12, 30, 0);
const window = windowAt(NOW, [NOW - 3_600_000, NOW - 60_000]);

describe("the reads", () => {
  it("name the recorder's columns by position", () => {
    const sql = requestOutcomesSql("request_outcomes", window);
    expect(sql).toContain(`blob${REQUEST_BLOBS.indexOf("outcome") + 1} IN ('server_error', 'exception', 'canceled')`);
    expect(sql).toContain(`double${REQUEST_DOUBLES.indexOf("is_synthetic") + 1} AS is_synthetic`);
    expect(sql).toContain("index1 AS version_id");
    for (let w = 0; w < window.starts.length; w++) for (let i = 0; i <= LATENCY_BOUNDS_MS.length; i++) expect(sql).toContain(`AS h${w}_${i}`);
  });

  it("bound the window and exclude unknown durations from the histogram", () => {
    const sql = requestOutcomesSql("request_outcomes", window);
    for (const start of window.starts) expect(sql).toContain(`timestamp >= toDateTime(${Math.floor(start / 1000)})`);
    expect(sql).toContain(`double${REQUEST_DOUBLES.indexOf("duration_ms") + 1} >= 0`);
  });

  it("group the totals by version and flags, never by client", () => {
    const sql = requestOutcomesSql("request_outcomes", window);
    expect(sql).toMatch(/GROUP BY version_id, worker, version_override, is_synthetic LIMIT/);
    expect(sql).not.toContain("principal");
  });

  it("list clients by rank among the non-synthetic, cut by a limit that is not a refusal", () => {
    const sql = topClientsSql("request_outcomes", window, "principal_hash");
    expect(sql).toContain(`double${REQUEST_DOUBLES.indexOf("is_synthetic") + 1} = 0`);
    expect(sql).toContain(`HAVING sum(_sample_interval) >= ${MIN_CLIENT_SAMPLES}`);
    expect(sql).toContain(`ORDER BY s0 DESC LIMIT ${TOP_CLIENTS}`);
    expect(topClientsSql("request_outcomes", window, "ip_hash")).toContain(`blob${REQUEST_BLOBS.indexOf("ip_hash") + 1} != ''`);
  });

  it("select only the signals the gates read", () => {
    const sql = domainEventsSql("domain_events", window);
    expect(sql).toContain("'selftest.result'");
    expect(sql).not.toContain("'http.request'");
    expect(syntheticProbesSql("synthetic_probes", window)).toContain("index1 = 'synthetic.probe'");
  });
});

describe("one version's clients", () => {
  it("are ranked inside the version, by samples or by bad, and the version id is checked", () => {
    const bySamples = versionClientsSql("request_outcomes", window, "principal_hash", "web-v2", "samples", 0);
    expect(bySamples).toContain("index1 = 'web-v2'");
    expect(bySamples).toContain(`ORDER BY s0 DESC LIMIT ${CANDIDATE_TOP}`);
    expect(versionClientsSql("request_outcomes", window, "ip_hash", "web-v2", "bad", 0)).toContain(`ORDER BY b0 DESC LIMIT ${CANDIDATE_TOP}`);
    expect(() => versionClientsSql("request_outcomes", window, "ip_hash", "x' OR '1'='1", "bad", 0)).toThrow(/not a version id/);
  });

  it("are ranked by the candidate's own stage columns, which the 24 h columns can disagree with", () => {
    const staged = { ...window, candidates: [{ version: "web-v2", index: 1 }] };
    expect(versionClientsSql("request_outcomes", staged, "principal_hash", "web-v2", "samples", 1)).toContain("ORDER BY s1 DESC");
    expect(versionClientsSql("request_outcomes", staged, "principal_hash", "web-v2", "bad", 1)).toContain("ORDER BY b1 DESC");
  });

  it("are read four ways per candidate and marked complete for it", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response(JSON.stringify({ data: [] })))) as unknown as typeof fetch;
    const data = await analyticsGateData({ accountId: async () => "a", token: async () => "t", datasetSuffix: "" }, fetchImpl).requestOutcomes({ ...window, candidates: [{ version: "web-v2", index: 0 }] });
    expect(bodies).toHaveLength(3 + 4);
    expect(data.exactVersions).toEqual(["web-v2"]);
    expect(data.listsCut).toBe(false);
  });

  it("report the global lists as cut when they hit their limit", async () => {
    const full = Array.from({ length: TOP_CLIENTS }, (_, i) => ({ version_id: "v", client: `c${i}`, s0: 30, b0: 0, s1: 30, b1: 0 }));
    const fetchImpl = (async (_u: string, init: RequestInit) => new Response(JSON.stringify({ data: String(init.body).includes("GROUP BY version_id, client HAVING") ? full : [] }))) as unknown as typeof fetch;
    expect((await analyticsGateData({ accountId: async () => "a", token: async () => "t", datasetSuffix: "" }, fetchImpl).requestOutcomes(window)).listsCut).toBe(true);
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

  it("answers totals, principals and ips from three statements and shapes each window", async () => {
    const bodies: string[] = [];
    const answer = (body: string) =>
      body.includes("GROUP BY version_id, client")
        ? [{ version_id: "v", client: "p1", s0: "50", b0: 2, s1: "40", b1: 1 }]
        : [{ version_id: "v", worker: "web", version_override: "0", is_synthetic: 1, today: 10, recent: 5, s0: "10", b0: 1, d0: 2, h0_2: "9", h0_16: 1, s1: 4 }];
    const fetchImpl = (async (_url: string, init: RequestInit) => (bodies.push(String(init.body)), new Response(JSON.stringify({ data: answer(String(init.body)) })))) as unknown as typeof fetch;
    const data = await analyticsGateData(config, fetchImpl).requestOutcomes(window);
    expect(bodies).toHaveLength(3);
    const [g] = data.groups;
    expect(g).toMatchObject({ version_id: "v", override: false, synthetic: true, today: 10, recent: 5 });
    expect(g?.windows).toHaveLength(2);
    expect(g?.windows[0]).toMatchObject({ samples: 10, bad: 1, downloads: 2 });
    expect(g?.windows[0]?.latency[2]).toBe(9);
    expect(g?.windows[0]?.latency[LATENCY_BOUNDS_MS.length]).toBe(1);
    expect(data.principals[0]).toEqual({ version_id: "v", key: "p1", windows: [{ samples: 50, bad: 2 }, { samples: 40, bad: 1 }] });
    expect(data.ips).toHaveLength(1);
  });

  it("does not take a full client list for a refusal, but does for the totals", async () => {
    const full = Array.from({ length: ROW_LIMIT }, (_, i) => ({ version_id: "v", client: `c${i}`, s0: 30, b0: 0, s1: 30, b1: 0 }));
    const clientsOnly = (async (_u: string, init: RequestInit) => new Response(JSON.stringify({ data: String(init.body).includes("GROUP BY version_id, client") ? full : [] }))) as unknown as typeof fetch;
    expect((await analyticsGateData(config, clientsOnly).requestOutcomes(window)).principals).toHaveLength(ROW_LIMIT);
    const totalsFull = (async (_u: string, init: RequestInit) => new Response(JSON.stringify({ data: String(init.body).includes("GROUP BY version_id, worker") ? Array.from({ length: ROW_LIMIT }, () => ({})) : [] }))) as unknown as typeof fetch;
    await expect(analyticsGateData(config, totalsFull).requestOutcomes(window)).rejects.toThrow(/incomplete/);
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
