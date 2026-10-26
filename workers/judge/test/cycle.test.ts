import type { GateReport, ReleaseRecord } from "@packserver/core/gates";
import { describe, expect, it } from "vitest";
import { evaluateGates, MAX_GATE_POINTS } from "../src/gates/cycle";
import { gatesStore } from "../src/gates/store";
import { FakeGateData, group, judgeFakes } from "./support";

const setup = () => {
  const fakes = judgeFakes();
  const data = new FakeGateData();
  const deps = { clock: fakes.clock, gatesKv: fakes.kv["GATES_KV"] as NonNullable<(typeof fakes.kv)[string]>, data, stats: fakes.stats };
  const report = async (v: string): Promise<GateReport> => (await gatesStore(deps.gatesKv).report(v)) as GateReport;
  return { fakes, data, deps, report };
};

const RELEASE: ReleaseRecord = { release_id: "1.2.3+abc1234", state: "rolling", workers: { web: { version_id: "web-new", changed: true }, mcp: { version_id: "mcp-old", changed: false } } };

describe("an evaluation cycle", () => {
  it("reads each dataset once and reports every tracked version", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-old", "web", 50_000), group("web-new", "web", 400, 2)];
    const cycle = await evaluateGates(deps, RELEASE, "launch");
    expect(data.reads).toEqual(["request_outcomes", "domain_events", "synthetic_probes"]);
    expect(cycle.versions).toBe(2);
    const fresh = await report("web-new");
    expect(fresh).toMatchObject({ worker: "web", mode: "launch", source: "real", release_id: "1.2.3+abc1234", stage_end: false });
    expect(fresh.gates["gate.availability"]).toMatchObject({ status: "pass", samples: 400, binding: true });
    expect((await report("web-old")).release_id).toBeNull();
  });

  it("tracks a candidate that has no traffic yet", async () => {
    const { deps, report } = setup();
    await evaluateGates(deps, RELEASE, "pre-launch");
    expect((await report("web-new")).gates["gate.availability"]?.status).toBe("insufficient");
    expect(await report("mcp-old")).toBeNull();
  });

  it("judges the new version against the Worker's busiest other version", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-old", "web", 100_000, 10), group("web-new", "web", 2_000, 20)];
    await evaluateGates(deps, RELEASE, "launch");
    const verdict = (await report("web-new")).gates["gate.availability"];
    expect(verdict?.status).toBe("fail");
    expect(verdict?.p_fisher).not.toBeNull();
  });

  it("keeps override and synthetic requests out of real traffic, and counts them under source all", async () => {
    const { data, deps, report } = setup();
    // 2 requests a second is above the low-traffic line, so `real` applies.
    data.groups = [group("web-new", "web", 400, 0, { recent: 1800 }), group("web-new", "web", 400, 400, { synthetic: true, recent: 0 }), group("web-new", "web", 400, 400, { override: true, recent: 0 })];
    await evaluateGates(deps, RELEASE, "launch");
    const real = await report("web-new");
    expect(real.source).toBe("real");
    expect(real.gates["gate.availability"]).toMatchObject({ status: "pass", samples: 400 });
  });

  it("falls back to source all while real traffic is under 1 request a second", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-new", "web", 400, 0, { recent: 100 }), group("web-new", "web", 400, 0, { synthetic: true, recent: 800 })];
    await evaluateGates(deps, RELEASE, "launch");
    const low = await report("web-new");
    expect(low.source).toBe("all");
    expect(low.gates["gate.availability"]?.samples).toBe(800);
  });

  it("marks only the self-test and synthetic gates binding before launch, but computes the rest", async () => {
    const { data, deps, report } = setup();
    data.groups = [group("web-new", "web", 400, 0, { recent: 2000 })];
    await evaluateGates(deps, RELEASE, "pre-launch");
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
    await evaluateGates(deps, RELEASE, "launch");
    const gates = (await report("web-new")).gates;
    expect(gates["gate.selftest"]?.status).toBe("pass");
    expect(gates["gate.domain.hash_integrity"]?.status).toBe("fail");
    expect(gates["gate.queue.backlog"]?.status).toBe("fail");
    // The index fetch failed in the last run, so that run failed; it is the latest, so the synthetic gate waits for the next.
    expect(gates["gate.synthetic"]?.status).toBe("watching");
    expect(gates["gate.domain.index_fetch_success"]?.status).toBe("fail");
  });

  it("writes gate.evaluated only for verdicts that changed", async () => {
    const { fakes, data, deps } = setup();
    data.groups = [group("web-new", "web", 400)];
    await evaluateGates(deps, RELEASE, "launch");
    const first = fakes.stats.points.filter((p) => p.name === "gate.evaluated").length;
    expect(first).toBeGreaterThan(0);
    // The second cycle moves the proportion gates from their decision to `watching`; after that nothing is news.
    await evaluateGates(deps, RELEASE, "launch");
    const settled = fakes.stats.points.filter((p) => p.name === "gate.evaluated").length;
    await evaluateGates(deps, RELEASE, "launch");
    expect(fakes.stats.points.filter((p) => p.name === "gate.evaluated")).toHaveLength(settled);
    data.groups = [group("web-new", "web", 800, 60)];
    await evaluateGates(deps, RELEASE, "launch");
    const later = fakes.stats.points.filter((p) => p.name === "gate.evaluated").slice(settled);
    expect(later.map((p) => p.blobs.slice(0, 2).join(" "))).toContain("gate.availability fail");
    expect(later[0]?.index).toBe("web-new");
  });

  it("stays inside the invocation's point budget and says what it left out", async () => {
    const { fakes, data, deps } = setup();
    data.groups = Array.from({ length: 6 }, (_, i) => group(`web-${i}`, "web", 400));
    const cycle = await evaluateGates(deps, null, "launch");
    expect(cycle.pointsWritten).toBe(MAX_GATE_POINTS);
    expect(cycle.pointsDropped).toBeGreaterThan(0);
    expect(fakes.stats.points.filter((p) => p.name === "gate.evaluated")).toHaveLength(MAX_GATE_POINTS);
  });
});
