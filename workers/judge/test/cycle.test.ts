import type { GateReport, ReleaseRecord } from "@packserver/core/gates";
import { describe, expect, it } from "vitest";
import { evaluateGates, MAX_AUDIT_POINTS, MAX_GATE_POINTS, POINTS_PER_INVOCATION } from "../src/gates/cycle";
import { gatesStore } from "../src/gates/store";
import { counts, FakeGateData, group, judgeFakes } from "./support";

const setup = () => {
  const fakes = judgeFakes();
  const data = new FakeGateData();
  const deps = { clock: fakes.clock, gatesKv: fakes.kv["GATES_KV"] as NonNullable<(typeof fakes.kv)[string]>, data, stats: fakes.stats };
  const report = async (v: string): Promise<GateReport> => (await gatesStore(deps.gatesKv).report(v)) as GateReport;
  /** A candidate's stage starts at the first cycle that sees it; its counts begin at the next. */
  const begin = async (release: ReleaseRecord | null, mode: "launch" | "pre-launch" = "launch") => {
    await evaluateGates(deps, release, mode);
    fakes.clock.advance("1m");
  };
  const points = () => fakes.stats.points.filter((p) => p.name === "gate.evaluated");
  return { fakes, data, deps, report, begin, points };
};

const RELEASE: ReleaseRecord = { release_id: "1.2.3+abc1234", state: "rolling", workers: { web: { version_id: "web-new", changed: true }, mcp: { version_id: "mcp-old", changed: false } } };

describe("an evaluation cycle", () => {
  it("reads each dataset once and reports every tracked version", async () => {
    const { data, deps, report, begin } = setup();
    data.groups = [group("web-old", "web", 50_000), group("web-new", "web", 400, 2)];
    await begin(RELEASE);
    data.reads.length = 0;
    const cycle = await evaluateGates(deps, RELEASE, "launch");
    expect(data.reads).toEqual(["request_outcomes", "domain_events", "synthetic_probes"]);
    expect(cycle.versions).toBe(2);
    const fresh = await report("web-new");
    expect(fresh).toMatchObject({ worker: "web", mode: "launch", source: "real", release_id: "1.2.3+abc1234", stale: false, stage_end: false });
    expect(fresh.gates["gate.availability"]).toMatchObject({ status: "pass", samples: 400, binding: true });
    expect((await report("web-old")).release_id).toBeNull();
  });

  it("tracks a candidate that has no traffic yet", async () => {
    const { deps, report } = setup();
    await evaluateGates(deps, RELEASE, "pre-launch");
    expect((await report("web-new")).gates["gate.availability"]?.status).toBe("insufficient");
    expect(await report("mcp-old")).toBeNull();
  });

  it("counts nothing for a candidate in the cycle that first sees it: its stage starts there", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-new", "web", 5000)];
    await evaluateGates(deps, RELEASE, "launch");
    expect((await report("web-new")).gates["gate.availability"]).toMatchObject({ status: "insufficient", samples: 0 });
  });

  it("judges the new version against the Worker's busiest other version", async () => {
    const { data, deps, report, begin } = setup();
    data.groups = [group("web-old", "web", 100_000, 10), group("web-new", "web", 2_000, 20)];
    await begin(RELEASE);
    await evaluateGates(deps, RELEASE, "launch");
    const verdict = (await report("web-new")).gates["gate.availability"];
    expect(verdict?.status).toBe("fail");
    expect(verdict?.p_fisher).not.toBeNull();
  });

  it("reads the candidate and its baseline over the same minutes, from the stage start", async () => {
    const { fakes, data, deps, report, begin } = setup();
    const t0 = fakes.clock.now();
    // 10 requests a second for both versions, for as long as a window reaches back.
    data.provider = (window) => ({
      groups: ["web-old", "web-new"].map((v) => ({
        version_id: v, worker: "web", override: false, synthetic: false, today: 0, recent: 9000,
        windows: window.starts.map((start) => counts(Math.round(((fakes.clock.now() - start) / 1000) * 10), 0)),
      })),
      principals: [],
      ips: [],
      exactVersions: window.candidates,
      listsCut: false,
    });
    await begin(RELEASE);
    fakes.clock.advance("10m");
    await evaluateGates(deps, RELEASE, "launch");
    const gate = (await report("web-new")).gates["gate.availability"];
    expect(gate?.samples).toBe(6600); // 11 minutes from the first cycle
    const windows = data.windows.at(-1);
    expect(windows?.starts).toEqual([fakes.clock.now() - 24 * 3_600_000, t0]);
    // The incumbent is judged over the day; the candidate's baseline over the candidate's minutes.
    expect((await report("web-old")).gates["gate.availability"]?.samples).toBe(864_000);
    expect(fakes.clock.now() - (windows?.starts[1] as number)).toBe(11 * 60_000);
  });

  it("starts a new stage, with no decisions carried, when the release changes state", async () => {
    const { data, deps, report, begin } = setup();
    data.groups = [group("web-new", "web", 400)];
    await begin(RELEASE);
    await evaluateGates(deps, RELEASE, "launch");
    expect((await gatesStore(deps.gatesKv).memory("web-new"))["gate.availability"]?.decided_at).toBe(300);
    await evaluateGates(deps, { ...RELEASE, state: "live" }, "launch");
    expect((await report("web-new")).gates["gate.availability"]?.samples).toBe(0);
    expect((await gatesStore(deps.gatesKv).memory("web-new"))["gate.availability"]).toBeUndefined();
  });

  it("keeps override and synthetic requests out of real traffic", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-new", "web", 400, 0, { recent: 1800 }), group("web-new", "web", 400, 400, { synthetic: true, recent: 0 }), group("web-new", "web", 400, 400, { override: true, recent: 0 })];
    await evaluateGates(deps, null, "launch");
    const real = await report("web-new");
    expect(real.source).toBe("real");
    expect(real.gates["gate.availability"]).toMatchObject({ status: "pass", samples: 400 });
  });

  it("falls back to source all while real traffic is under 1 request a second", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-new", "web", 400, 0, { recent: 100 }), group("web-new", "web", 400, 0, { synthetic: true, recent: 800 })];
    await evaluateGates(deps, null, "launch");
    const low = await report("web-new");
    expect(low.source).toBe("all");
    expect(low.gates["gate.availability"]?.samples).toBe(800);
  });

  it("does not call a quiet version suspect because the prober is most of its traffic", async () => {
    const { data, deps, report } = setup();
    // 1,000 real requests and 1,800 from the prober, at under 1 request a second: source all, the prober is 64% of the samples.
    data.groups = [group("web-new", "web", 1000, 0, { recent: 100 }), group("web-new", "web", 1800, 0, { synthetic: true, recent: 800 })];
    data.principals = [{ version_id: "web-new", key: "p1", samples: 100, bad: 0 }];
    data.ips = [{ version_id: "web-new", key: "ip1", samples: 150, bad: 0 }];
    await evaluateGates(deps, null, "launch");
    const gates = (await report("web-new")).gates;
    expect((await report("web-new")).source).toBe("all");
    expect(gates["gate.availability"]?.status).toBe("pass");
    expect(gates["gate.p99_latency"]?.status).toBe("pass");
  });

  it("still calls a version suspect when one real client is most of its real traffic", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-new", "web", 1000, 0, { recent: 100 }), group("web-new", "web", 1800, 0, { synthetic: true, recent: 800 })];
    data.principals = [{ version_id: "web-new", key: "p1", samples: 300, bad: 0 }];
    await evaluateGates(deps, null, "launch");
    expect((await report("web-new")).gates["gate.availability"]?.status).toBe("suspect");
  });

  it("marks only the self-test and synthetic gates binding before launch, but computes the rest", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-new", "web", 400, 0, { recent: 2000 })];
    await evaluateGates(deps, null, "pre-launch");
    const gates = (await report("web-new")).gates;
    expect(Object.values(gates).filter((g) => g?.binding).map((g) => g?.gate).sort()).toEqual(["gate.selftest", "gate.synthetic"]);
    expect(gates["gate.availability"]?.status).toBe("pass");
  });

  it("reads self-test, probe runs, hash mismatches and queues from the domain datasets", async () => {
    const { fakes, data, deps, report } = setup();
    const at = fakes.clock.now();
    data.groups = [group("web-new", "web", 400)];
    data.domain = [
      { signal: "selftest.result", version_id: "web-new", attrs: '{"ok":true}', n: 1, recent: 1, ts: at - 60_000, d1: -1, d2: -1 },
      { signal: "download.hash_mismatch", version_id: "web-new", attrs: "{}", n: 1, recent: 1, ts: at, d1: -1, d2: -1 },
      { signal: "queue.backlog", version_id: "validator-1", attrs: '{"queue":"audit"}', n: 3, recent: 3, ts: at, d1: 4, d2: 301 },
      { signal: "queue.dlq", version_id: "validator-1", attrs: '{"queue":"audit"}', n: 1, recent: 1, ts: at, d1: -1, d2: -1 },
    ];
    const probe = (run: string, scenario: string, ok: boolean, offset: number, extra = "") => ({ attrs: `{"target":"web-new","run":"${run}","scenario":"${scenario}","ok":${ok}${extra}}`, n: 1, ts: at - offset });
    data.probes = [
      probe("r1", "adopt.public_pack", true, 300_000), probe("r1", "update_check.signed_index", true, 299_000, ',"stale_s":30'),
      probe("r2", "adopt.public_pack", true, 200_000), probe("r2", "update_check.signed_index", true, 199_000, ',"stale_s":30'),
      probe("r3", "adopt.public_pack", true, 100_000), probe("r3", "update_check.signed_index", false, 99_000, ',"stale_s":30'),
    ];
    await evaluateGates(deps, null, "launch");
    const gates = (await report("web-new")).gates;
    expect(gates["gate.selftest"]?.status).toBe("pass");
    expect(gates["gate.domain.hash_integrity"]?.status).toBe("fail");
    expect(gates["gate.queue.backlog"]?.status).toBe("fail");
    expect(gates["gate.synthetic"]?.status).toBe("watching");
    expect(gates["gate.domain.index_fetch_success"]?.status).toBe("fail");
  });

  it("writes gate.evaluated only for verdicts that changed", async () => {
    const { data, deps, points } = setup();
    data.groups = [group("web-new", "web", 400)];
    await evaluateGates(deps, null, "launch");
    expect(points().length).toBeGreaterThan(0);
    await evaluateGates(deps, null, "launch");
    const settled = points().length;
    await evaluateGates(deps, null, "launch");
    expect(points()).toHaveLength(settled);
    data.groups = [group("web-new", "web", 800, 60)];
    await evaluateGates(deps, null, "launch");
    const later = points().slice(settled);
    expect(later.map((p) => p.blobs.slice(0, 2).join(" "))).toContain("gate.availability fail");
    expect(later[0]?.index).toBe("web-new");
  });
});

describe("the invocation's point budget", () => {
  it("is Analytics Engine's 250 less the heartbeat and the audit signals", () => {
    expect(POINTS_PER_INVOCATION).toBe(250);
    expect(MAX_GATE_POINTS + MAX_AUDIT_POINTS + 1).toBe(POINTS_PER_INVOCATION);
  });

  it("writes failures first, and carries what does not fit to the next cycle", async () => {
    const { fakes, data, deps, points } = setup();
    // 30 versions of 8 gates is more than one invocation holds; the failing version must not be the one dropped.
    data.groups = [...Array.from({ length: 29 }, (_, i) => group(`web-${String(i).padStart(2, "0")}`, "web", 400)), group("web-zzz", "web", 400, 40)];
    const first = await evaluateGates(deps, null, "launch");
    expect(first.pointsWritten).toBe(MAX_GATE_POINTS);
    expect(first.pointsDeferred).toBeGreaterThan(0);
    expect(points().some((p) => p.index === "web-zzz" && p.blobs[0] === "gate.availability" && p.blobs[1] === "fail")).toBe(true);
    // What was dropped is still different from what was written, so it goes next cycle.
    fakes.clock.advance("1m");
    const second = await evaluateGates(deps, null, "launch");
    expect(second.pointsWritten).toBeGreaterThan(0);
    fakes.clock.advance("1m");
    expect((await evaluateGates(deps, null, "launch")).pointsDeferred).toBe(0);
    const seen = new Set(points().map((p) => `${p.index}|${p.blobs[0]}`));
    expect(seen.size).toBe(30 * 8);
  });
});

describe("a stage that lasts", () => {
  it("keeps its start, its counts and its decisions across hours in one rolling state", async () => {
    const { fakes, data, deps, report } = setup();
    const t0 = fakes.clock.now();
    data.provider = (window) => ({
      groups: [{
        version_id: "web-new", worker: "web", override: false, synthetic: false, today: 0, recent: 9000,
        windows: window.starts.map((start) => counts(Math.round(((fakes.clock.now() - start) / 1000) * 10), 0)),
      }],
      principals: [], ips: [], exactVersions: window.candidates, listsCut: false,
    });
    await evaluateGates(deps, RELEASE, "launch");
    for (let i = 0; i < 31; i++) {
      fakes.clock.advance("5m");
      await evaluateGates(deps, RELEASE, "launch");
    }
    const stage = await gatesStore(deps.gatesKv).stage("web-new");
    expect(stage?.started_at).toBe(t0);
    expect(fakes.clock.now() - t0).toBe(31 * 5 * 60_000);
    expect((await report("web-new")).gates["gate.availability"]?.samples).toBe(93_000);
    const memory = await gatesStore(deps.gatesKv).memory("web-new");
    expect(memory["gate.availability"]?.decided_at).toBeGreaterThan(300);
    // And a day later, still the same stage.
    fakes.clock.advance("23h");
    await evaluateGates(deps, RELEASE, "launch");
    expect((await gatesStore(deps.gatesKv).stage("web-new"))?.started_at).toBe(t0);
  });

  it("keeps a zero-tolerance failure across the rolling to live restart, and drops the stage's counts", async () => {
    const { fakes, data, deps, report, begin } = setup();
    data.groups = [group("web-new", "web", 400)];
    await begin(RELEASE);
    const at = fakes.clock.now();
    const probe = (run: string, ok: boolean, offset: number) => ({ attrs: `{"target":"web-new","run":"${run}","scenario":"adopt.public_pack","ok":${ok}}`, n: 1, ts: at - offset });
    data.probes = [probe("r1", true, 50_000), probe("r2", false, 40_000), probe("r3", false, 30_000)];
    await evaluateGates(deps, RELEASE, "launch");
    expect((await report("web-new")).gates["gate.synthetic"]?.status).toBe("fail");
    fakes.clock.advance("1m");
    await evaluateGates(deps, { ...RELEASE, state: "live" }, "launch");
    const gates = (await report("web-new")).gates;
    expect(gates["gate.availability"]?.samples).toBe(0);
    expect(gates["gate.synthetic"]?.status).toBe("fail");
    expect((await gatesStore(deps.gatesKv).stage("web-new"))?.release_started_at).toBeLessThan(fakes.clock.now());
  });

  it("starts the evidence over for a different release", async () => {
    const { fakes, data, deps, report, begin } = setup();
    data.groups = [group("web-new", "web", 400)];
    await begin(RELEASE);
    const at = fakes.clock.now();
    data.probes = [0, 1].map((i) => ({ attrs: `{"target":"web-new","run":"r${i}","scenario":"s","ok":false}`, n: 1, ts: at - 60_000 + i }));
    await evaluateGates(deps, RELEASE, "launch");
    fakes.clock.advance("1m");
    await evaluateGates(deps, { ...RELEASE, release_id: "next" }, "launch");
    expect((await report("web-new")).gates["gate.synthetic"]?.status).toBe("insufficient");
  });

  it("counts domain events from the candidate's stage, not the whole lookback", async () => {
    const { fakes, data, deps, report, begin } = setup();
    data.groups = [group("web-new", "web", 400, 0, { recent: 2000 })];
    await begin(RELEASE);
    data.domain = [{ signal: "download.hash_mismatch", version_id: "web-new", attrs: "{}", n: 3, windows: [3, 0], recent: 0, ts: fakes.clock.now() - 7_200_000, d1: -1, d2: -1 }];
    await evaluateGates(deps, RELEASE, "launch");
    expect((await report("web-new")).gates["gate.domain.hash_integrity"]).toMatchObject({ observed: 0 });
  });
});

describe("a dominant client among many", () => {
  const rel: ReleaseRecord = { release_id: "r", state: "rolling", workers: { web: { version_id: "web-new", changed: true } } };

  it("is caught for a small candidate whose clients all rank below the incumbent's", async () => {
    const { data, deps, report, begin } = setup();
    // The incumbent has thousands of clients of 50 requests each; the candidate's one heavy client has 120, far below the global cut.
    data.groups = [group("web-old", "web", 1_000_000, 0, { recent: 90_000 }), group("web-new", "web", 400, 0, { recent: 90_000 })];
    data.principals = [{ version_id: "web-new", key: "p-heavy", samples: 120, bad: 0 }];
    data.listsCut = true;
    await begin(rel);
    await evaluateGates(deps, rel, "launch");
    expect(data.windows.at(-1)?.candidates).toEqual(["web-new"]);
    expect((await report("web-new")).gates["gate.availability"]?.status).toBe("suspect");
  });

  it("is caught when it carries most of the bad samples without being a heavy client", async () => {
    const { data, deps, report, begin } = setup();
    data.groups = [group("web-new", "web", 1000, 10, { recent: 90_000 })];
    data.principals = [{ version_id: "web-new", key: "p-quiet", samples: 4, bad: 4 }];
    await begin(rel);
    await evaluateGates(deps, rel, "launch");
    expect((await report("web-new")).gates["gate.availability"]?.status).not.toBe("suspect");
    data.principals = [{ version_id: "web-new", key: "p-quiet", samples: 6, bad: 6 }];
    await evaluateGates(deps, rel, "launch");
    expect((await report("web-new")).gates["gate.availability"]?.status).toBe("suspect");
  });

  it("reads concentration as unknown, not as absent, for a version whose lists were cut", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-steady", "web", 5000, 0, { recent: 90_000 })];
    data.listsCut = true;
    await evaluateGates(deps, null, "launch");
    const gate = (await report("web-steady")).gates["gate.availability"];
    expect(gate?.status).toBe("insufficient");
    expect(gate?.reasons[0]).toMatch(/cannot be ruled out/);
    expect((await report("web-steady")).gates["gate.p99_latency"]?.status).toBe("insufficient");
  });
});
