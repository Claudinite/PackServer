import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "@packserver/ports/fakes";
import {
  analyticsStats, createHasher, createModeCache, createTelemetry, datasetFor, dedupeKey, logRate, network, parseUserAgent,
  REQUEST_BLOBS, REQUEST_DOUBLES, ANALYTICS_DATASETS, SIGNAL_NAMES, scrubIp, type Fetcher, type PrivateDownload,
} from "./index";
import { TelemetrySink, toHaveRecorded } from "./testing";

expect.extend({ toHaveRecorded });

const here = fileURLToPath(new URL(".", import.meta.url));
const monitoring = readFileSync(join(here, "../../../docs/operations/monitoring.md"), "utf8");

const KEYS = { ipMaster: "master-ip-key", principalKey: "principal-key" };
const setup = (worker = "web") => {
  const clock = new FakeClock();
  const sink = new TelemetrySink();
  const telemetry = createTelemetry({ worker, releaseId: "1.0.0+abc1234", versionId: "ver-1", stats: sink, clock, hasher: createHasher(KEYS, clock), log: sink.log });
  return { clock, sink, telemetry };
};
const obs = (over: Record<string, unknown> = {}) => ({
  method: "GET", route: "/api/packs/:id", status: 200, durationMs: 12, versionOverride: false, facts: {}, ...over,
});
const always = { mode: "normal" as const, random: () => 0 };

describe("the signal catalogue and monitoring.md", () => {
  const section = monitoring.slice(monitoring.indexOf("- **download**"), monitoring.indexOf("Datasets:"));
  const documented = (() => {
    const names: string[] = [];
    let area = "";
    for (const m of section.matchAll(/\*\*([a-z_]+)\*\*|`([a-z_]+)`/g)) {
      if (m[1]) area = m[1];
      else names.push(`${area}.${m[2]}`);
    }
    return names;
  })();

  it("names exactly the signals the catalogue lists", () => {
    expect([...documented].sort()).toEqual([...SIGNAL_NAMES].sort());
  });

  it("names exactly the datasets the catalogue lists", () => {
    const line = monitoring.slice(monitoring.indexOf("Datasets:"), monitoring.indexOf("The shadow dataset"));
    const names = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect([...names].sort()).toEqual([...ANALYTICS_DATASETS].sort());
  });

  it("routes each signal to one dataset", () => {
    expect(datasetFor("http.request")).toBe("request_outcomes");
    expect(datasetFor("download.served")).toBe("downloads");
    expect(datasetFor("validation.step")).toBe("validation_events");
    expect(datasetFor("synthetic.probe")).toBe("synthetic_probes");
    expect(datasetFor("gate.evaluated")).toBe("gate_results");
    expect(datasetFor("budget.usage")).toBe("budget");
    expect(datasetFor("download.hash_mismatch")).toBe("domain_events");
  });
});

describe("IT-TELEM-006 no raw IP anywhere", () => {
  it("hashes an address under a key that changes every day", async () => {
    const clock = new FakeClock();
    const hasher = createHasher(KEYS, clock);
    const today = await hasher.ip("198.51.100.77");
    expect(today).toMatch(/^[0-9a-f]{64}$/);
    expect(await hasher.ip("198.51.100.77")).toBe(today);
    expect(await hasher.ip("::ffff:198.51.100.77")).toBe(today);
    clock.advance("1d");
    expect(await hasher.ip("198.51.100.77")).not.toBe(today);
  });

  it("leaves a hash out when its key is not configured", async () => {
    const hasher = createHasher({}, new FakeClock());
    expect(await hasher.ip("198.51.100.77")).toBeUndefined();
    expect(await hasher.principal("session", "u1")).toBeUndefined();
  });

  it("truncates to the network the request records keep", () => {
    expect(network("198.51.100.77")).toBe("198.51.100.0/24");
    expect(network("2001:db8:abcd:1234::1")).toBe("2001:0db8:abcd::/48");
    expect(network("nonsense")).toBeUndefined();
  });

  it("keeps the address out of every event, point and line", async () => {
    const { sink, telemetry } = setup();
    const ip = "198.51.100.77";
    await telemetry.request(
      obs({ ip, facts: { errorCode: `bad from ${ip}`, principal: { kind: "session", id: "u1" } } }),
      always,
    );
    telemetry.emit("auth.login", { note: `from ${ip}`, from6: "2001:db8::1" });
    await telemetry.download(download({ ip }));
    expect(sink.everything()).not.toContain(ip);
    expect(sink.everything()).not.toContain("2001:db8::1");
    expect(sink.recorded("auth.login")[0]?.fields).toEqual({ note: "from [ip]", from6: "[ip]" });
  });

  it("keeps the raw address out of the source: only the recorder middleware reads it", () => {
    const sources = [here, join(here, "../../../packages/http/src")].flatMap((dir) =>
      readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(dir, f)),
    );
    const readers = sources.filter((f) => /cf-connecting-ip/i.test(readFileSync(f, "utf8"))).map((f) => f.split("/").pop());
    expect(readers.sort()).toEqual(["ratelimit.ts", "recorder-middleware.ts"]);
    expect(scrubIp("a 10.0.0.1 b")).toBe("a [ip] b");
  });
});

describe("the wide event", () => {
  it("carries every monitoring.md field, as a console line and a request_outcomes point indexed by version", async () => {
    const { sink, telemetry } = setup();
    const { event } = await telemetry.request(
      obs({
        ip: "198.51.100.7", country: "NO", colo: "OSL", userAgent: "cn/1.4.2", cacheStatus: "HIT",
        facts: {
          principal: { kind: "token", id: "tok-1" }, scope: "@acme", pack: "@acme/gcp", journey: "adopt", errorCode: "none",
          cpuMs: 3, timings: { d1_ms: 4, r2_ms: 5, kv_ms: 1, do_ms: 2, vectorize_ms: 6, upstream_ms: 7 },
        },
      }),
      always,
    );
    const documented = ["principal_kind", "principal_hash", "scope", "pack", "client", "client_version", "ip_hash", "country", "worker", "http.route", "method", "journey", "outcome", "status", "error_code", "duration_ms", "cpu_ms", "d1_ms", "r2_ms", "kv_ms", "do_ms", "vectorize_ms", "upstream_ms", "version_id", "release_id", "colo", "cache_status", "version_override", "is_synthetic"];
    expect(Object.keys(event).sort()).toEqual([...documented].sort());
    const [line] = sink.logged();
    expect(line).toMatchObject({ event: "http.request", client: "cn", client_version: "1.4.2", pack: "@acme/gcp", d1_ms: 4, is_synthetic: false });
    const point = sink.points[0]!;
    expect(point.name).toBe("http.request");
    expect(point.index).toBe("ver-1");
    expect(point.blobs).toHaveLength(REQUEST_BLOBS.length);
    expect(point.doubles).toHaveLength(REQUEST_DOUBLES.length);
    expect(sink).toHaveRecorded("http.request", { worker: "web", status: 200, pack: "@acme/gcp", d1_ms: 4, client_version: "1.4.2" });
  });

  it("leaves an unknown field out and marks an unknown measurement -1, never zero", async () => {
    const { sink, telemetry } = setup();
    await telemetry.request(obs(), always);
    const [line] = sink.logged();
    expect(line).not.toHaveProperty("cpu_ms");
    expect(line).not.toHaveProperty("principal_hash");
    expect(line).not.toHaveProperty("scope");
    expect(sink.points[0]!.doubles[REQUEST_DOUBLES.indexOf("cpu_ms")]).toBe(-1);
    expect(sink).toHaveRecorded("http.request", { cpu_ms: undefined, pack: undefined });
  });

  it("sets is_synthetic from the probe principal and from nothing else", async () => {
    const { telemetry } = setup();
    const probe = await telemetry.request(obs({ facts: { principal: { kind: "synthetic", id: "@probe" } } }), always);
    const session = await telemetry.request(obs({ facts: { principal: { kind: "session", id: "u1" } }, userAgent: "probe/1 is_synthetic" }), always);
    expect(probe.event.is_synthetic).toBe(true);
    expect(session.event.is_synthetic).toBe(false);
  });

  it("derives the outcome unless a handler names one", async () => {
    const { telemetry } = setup();
    const outcome = async (over: Record<string, unknown>) => (await telemetry.request(obs(over), always)).event.outcome;
    expect(await outcome({ status: 200 })).toBe("ok");
    expect(await outcome({ status: 404 })).toBe("client_error");
    expect(await outcome({ status: 502 })).toBe("server_error");
    expect(await outcome({ status: 500, exception: true })).toBe("exception");
    expect(await outcome({ status: 499, canceled: true })).toBe("canceled");
    expect(await outcome({ status: 403, facts: { outcome: "refused" } })).toBe("refused");
  });

  it("keeps only cn's own version from a User-Agent", () => {
    expect(parseUserAgent("cn/1.4.2")).toEqual({ client: "cn", client_version: "1.4.2" });
    expect(parseUserAgent("Mozilla/5.0 (X11) secret-fingerprint")).toEqual({ client: "browser" });
    expect(parseUserAgent("curl/8.0 owner@example.com")).toEqual({ client: "other" });
    expect(parseUserAgent(undefined)).toBeUndefined();
  });
});

describe("telemetry never follows a repository (Ariel's ruling)", () => {
  it("withholds scope and pack from the wide event of a private request", async () => {
    const { sink, telemetry } = setup();
    await telemetry.request(obs({ facts: { visibility: "private", scope: "@secret", pack: "@secret/pack" } }), always);
    expect(sink.everything()).not.toContain("@secret");
  });

  it("refuses to record a public download: those are counted from the zone's request logs", async () => {
    const { sink, telemetry } = setup();
    await expect(telemetry.download({ ...download(), visibility: "public" } as unknown as PrivateDownload)).rejects.toThrow(/zone's request logs/);
    expect(sink.points).toEqual([]);
  });

  it("records a private fetch with the granted account and repository, whether the repository is public or private", async () => {
    const { sink, telemetry } = setup();
    await telemetry.download(download({ repository: { ownerId: "4242", name: "acme/app", visibility: "public" } }));
    await telemetry.download(download({ repository: { ownerId: "4242", name: "acme/secret-app", visibility: "private" } }));
    const rows = sink.recorded("download.served");
    expect(rows.map((r) => r.fields.repository)).toEqual(["acme/app", "acme/secret-app"]);
    expect(rows[0]!.fields).toMatchObject({
      pack: "@acme/private-pack", version: "1.0.0", fetcher: "cn_adopt", principal_kind: "oidc", repository_owner_id: "4242", client_version: "1.4.2", bytes: 2048,
    });
    expect(rows[0]!.index).toBe("opaque-version-id");
    expect(rows[0]!.dataset).toBe("downloads");
  });

  it("stores the affinity key and the principal only as keyed hashes", async () => {
    const { sink, telemetry } = setup();
    await telemetry.download(download({ affinityKey: "0123456789abcdef0123456789abcdef" }));
    const all = sink.everything();
    expect(all).not.toContain("0123456789abcdef0123456789abcdef");
    const f = sink.recorded("download.served")[0]!.fields;
    expect(f.affinity_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.principal_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sink.points)).not.toContain('"4242:');
  });

  it("writes a point for each fetcher, and none for fields cn did not send", async () => {
    const { sink, telemetry } = setup();
    for (const fetcher of ["cn_adopt", "cn_update", "mcp"] as Fetcher[]) await telemetry.download(download({ fetcher, repository: undefined, affinityKey: undefined, userAgent: undefined }));
    expect(sink.recorded("download.served").map((r) => r.fields.fetcher)).toEqual(["cn_adopt", "cn_update", "mcp"]);
    expect(sink.recorded("download.served")[0]!.fields).not.toHaveProperty("repository");
  });
});

describe("IT-TELEM-002 dedupe keys", () => {
  it("counts a private download once per principal, version and day", async () => {
    const { clock, sink, telemetry } = setup();
    for (let i = 0; i < 5; i++) await telemetry.download(download());
    const keys = new Set(sink.recorded("download.served").map((r) => r.fields.dedupe_key));
    expect(keys.size).toBe(1);
    clock.advance("1d");
    await telemetry.download(download());
    expect(new Set(sink.recorded("download.served").map((r) => r.fields.dedupe_key)).size).toBe(2);
    await telemetry.download(download({ principal: { kind: "oidc", id: "other" } }));
    expect(new Set(sink.recorded("download.served").map((r) => r.fields.dedupe_key)).size).toBe(3);
  });

  it("counts a public download once per /24 network, version and day", () => {
    const key = (ip: string, day = "2026-10-22") => dedupeKey({ visibility: "public", network: network(ip)! }, "v1", day);
    expect(key("198.51.100.7")).toBe(key("198.51.100.9"));
    expect(key("198.51.100.7")).not.toBe(key("198.51.101.7"));
    expect(key("198.51.100.7")).not.toBe(key("198.51.100.7", "2026-10-23"));
    expect(key("198.51.100.7")).not.toContain("198.51.100.7");
  });
});

describe("domain events", () => {
  it("are indexed by signal name, with attributes and numeric values kept apart", () => {
    const { sink, telemetry } = setup("publish");
    telemetry.emit("publish.received", { pack: "@acme/x", bytes: 10, quota: 3, dry_run: false });
    const [row] = sink.recorded("publish.received");
    expect(row!.index).toBe("publish.received");
    expect(row!.dataset).toBe("domain_events");
    expect(row!.point.blobs.slice(0, 3)).toEqual(["publish", "1.0.0+abc1234", "ver-1"]);
    expect(row!.point.doubles).toEqual([10, 3]);
    expect(sink).toHaveRecorded("publish.received", { pack: "@acme/x", dry_run: false });
    expect(sink).not.toHaveRecorded("publish.failed");
  });
});

describe("log sampling", () => {
  const base = { worker: "web", method: "GET", status: 200, principalKind: "session", mode: "normal" as const };
  it("keeps 15% of read-path lines and all write-path lines", () => {
    expect(logRate(base)).toBe(0.15);
    expect(logRate({ ...base, worker: "mcp" })).toBe(0.15);
    expect(logRate({ ...base, method: "POST" })).toBe(1);
    expect(logRate({ ...base, worker: "publish" })).toBe(1);
    expect(logRate({ ...base, worker: "validator" })).toBe(1);
  });
  it("logs every 5xx and synthetic or anonymous 4xx traffic at a low rate", () => {
    expect(logRate({ ...base, status: 503, principalKind: "anonymous" })).toBe(1);
    expect(logRate({ ...base, status: 503, mode: "economy" })).toBe(1);
    expect(logRate({ ...base, principalKind: "synthetic" })).toBe(0.05);
    expect(logRate({ ...base, principalKind: "anonymous", status: 404 })).toBe(0.05);
    expect(logRate({ ...base, status: 404 })).toBe(0.15);
  });
  it("stops anonymous 2xx and 4xx lines in economy mode and nothing else", () => {
    const economy = { ...base, mode: "economy" as const, principalKind: "anonymous" };
    expect(logRate({ ...economy, status: 200 })).toBe(0);
    expect(logRate({ ...economy, status: 404 })).toBe(0);
    expect(logRate({ ...economy, status: 302 })).toBe(0.15);
    expect(logRate({ ...economy, principalKind: "session", status: 200 })).toBe(0.15);
  });
  it("samples the line but never the point", async () => {
    const { sink, telemetry } = setup();
    const kept = await telemetry.request(obs({ facts: { principal: { kind: "session", id: "u" } } }), { mode: "normal", random: () => 0.14 });
    const dropped = await telemetry.request(obs({ facts: { principal: { kind: "session", id: "u" } } }), { mode: "normal", random: () => 0.16 });
    expect([kept.logged, dropped.logged]).toEqual([true, false]);
    expect(sink.lines).toHaveLength(1);
    expect(sink.recorded("http.request")).toHaveLength(2);
  });
});

describe("the telemetry_mode cache", () => {
  it("reads the KV once per isolate per 60 seconds", async () => {
    const clock = new FakeClock();
    const cache = createModeCache(clock);
    let value: string | null = "economy";
    const read = async () => value;
    expect(await cache.get(read)).toBe("economy");
    value = "normal";
    clock.advance("59s");
    expect(await cache.get(read)).toBe("economy");
    clock.advance("2s");
    expect(await cache.get(read)).toBe("normal");
    expect(cache.reads).toBe(2);
  });
  it("shares one read between concurrent requests", async () => {
    const cache = createModeCache(new FakeClock());
    let calls = 0;
    const read = async () => (calls++, "economy");
    expect(await Promise.all([cache.get(read), cache.get(read), cache.get(read)])).toEqual(["economy", "economy", "economy"]);
    expect(calls).toBe(1);
  });
  it("keeps the last value when the read fails, falls back to normal on a bad value, and counts failures", async () => {
    const clock = new FakeClock();
    const cache = createModeCache(clock);
    await cache.get(async () => "economy");
    clock.advance("61s");
    expect(await cache.get(async () => { throw new Error("kv down"); })).toBe("economy");
    expect(cache.failures).toBe(1);
    clock.advance("61s");
    expect(await cache.get(async () => "bogus")).toBe("normal");
    clock.advance("61s");
    expect(await cache.get(async () => null)).toBe("normal");
  });
});

describe("the Analytics Engine adapter", () => {
  const dataset = () => {
    const written: unknown[] = [];
    return { written, writeDataPoint: (p: unknown) => void written.push(p) };
  };
  it("routes a point to the dataset its name selects, with the signal or version as index1", () => {
    const [req, dom, dl, val] = [dataset(), dataset(), dataset(), dataset()];
    const stats = analyticsStats({ request_outcomes: req, domain_events: dom, downloads: dl, validation_events: val });
    stats.write({ name: "http.request", index: "ver-1", blobs: ["a"], doubles: [1] });
    stats.write({ name: "search.query", index: "search.query", blobs: [], doubles: [] });
    stats.write({ name: "download.served", index: "vid", blobs: [], doubles: [] });
    stats.write({ name: "validation.step", blobs: [], doubles: [] });
    expect(req.written).toEqual([{ indexes: ["ver-1"], blobs: ["a"], doubles: [1] }]);
    expect(dom.written).toHaveLength(1);
    expect(dl.written).toHaveLength(1);
    expect(val.written).toEqual([{ indexes: ["validation.step"], blobs: [], doubles: [] }]);
  });
  it("falls back to domain events for an unbound dataset and says so once when nothing is bound", () => {
    const dom = dataset();
    analyticsStats({ domain_events: dom }).write({ name: "download.served", blobs: [], doubles: [] });
    expect(dom.written).toHaveLength(1);
    const warnings: string[] = [];
    const none = analyticsStats({}, (l) => warnings.push(l));
    none.write({ name: "http.request", blobs: [], doubles: [] });
    none.write({ name: "http.request", blobs: [], doubles: [] });
    expect(warnings).toEqual(['{"event":"telemetry.no_dataset","dataset":"request_outcomes"}']);
  });
});

function download(over: Partial<PrivateDownload> = {}): PrivateDownload {
  return {
    visibility: "private", pack: "@acme/private-pack", version: "1.0.0", versionId: "opaque-version-id", fetcher: "cn_adopt",
    principal: { kind: "oidc", id: "4242" }, ip: "198.51.100.7", country: "NO", userAgent: "cn/1.4.2", bytes: 2048, ...over,
  };
}
