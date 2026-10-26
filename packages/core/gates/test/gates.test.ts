import { describe, expect, it } from "vitest";
import { dominantSource, evaluateVersion, emptyHistogram, LATENCY_BOUNDS_MS, type GateName, type GateStatus, type GateVerdict, type Mode, type Traffic, type VersionInputs, type VersionMemory } from "../index";

const NOW = 1_000_000_000_000;
const none = { principalSamples: 0, principalBad: 0, ipSamples: 0, ipBad: 0 };

/** `samples` requests of which `bad` failed, all answered in `ms`. */
function traffic(samples: number, bad: number, ms = 100, top = none): Traffic {
  const latency = emptyHistogram();
  latency[LATENCY_BOUNDS_MS.findIndex((b) => ms <= b)] = samples;
  return { samples, bad, downloads: 0, latency, top };
}

function inputs(patch: Partial<VersionInputs> = {}): VersionInputs {
  return {
    versionId: "v-new",
    worker: "web",
    traffic: traffic(0, 0),
    baseline: null,
    selftest: null,
    syntheticRuns: [],
    indexFetches: [],
    dryRuns: [],
    hashMismatches: 0,
    publishValidated: 0,
    publishFailed: 0,
    searchDegraded: 0,
    queues: [],
    dlqRecent: 0,
    ...patch,
  };
}

const gateOf = (verdicts: GateVerdict[], name: GateName): GateVerdict => {
  const v = verdicts.find((x) => x.gate === name);
  if (!v) throw new Error(`no ${name}`);
  return v;
};
const statusOf = (patch: Partial<VersionInputs>, name: GateName, mode: Mode = "launch", memory?: VersionMemory, stageEnd = false): GateStatus =>
  gateOf(evaluateVersion(inputs(patch), { now: NOW, mode, memory, stageEnd }).verdicts, name).status;

describe("availability and error rate (read Worker: 0.5% of 300)", () => {
  const status = (samples: number, bad: number): GateStatus => statusOf({ traffic: traffic(samples, bad) }, "gate.availability");

  it("waits below the floor", () => expect(status(299, 0)).toBe("insufficient"));
  it("passes at the floor with the bad share inside the threshold", () => {
    expect(status(300, 0)).toBe("pass");
    expect(status(300, 4)).toBe("pass");
    expect(status(300, 5)).toBe("pass");
  });
  it("fails once the binomial test rejects the threshold at alpha 0.01", () => {
    expect(status(300, 6)).toBe("fail");
    expect(status(300, 20)).toBe("fail");
  });
  it("answers both names from one evaluation", () => {
    const { verdicts } = evaluateVersion(inputs({ traffic: traffic(300, 20) }), { now: NOW, mode: "launch" });
    expect(gateOf(verdicts, "gate.error_rate")).toEqual({ ...gateOf(verdicts, "gate.availability"), gate: "gate.error_rate" });
  });
  it("holds a write Worker to 1%", () => {
    expect(statusOf({ worker: "publish", traffic: traffic(300, 8) }, "gate.availability")).toBe("pass");
    expect(statusOf({ worker: "publish", traffic: traffic(300, 9) }, "gate.availability")).toBe("fail");
  });
});

describe("baseline comparison", () => {
  // 1,000 samples at a 0.5% threshold: 14 bad is well past the binomial limit either way, so use a threshold the binomial test cannot see.
  it("fails a candidate the Fisher test finds worse than the baseline, given at least 5 bad events", () => {
    const base = traffic(10_000, 5);
    const verdict = gateOf(
      evaluateVersion(inputs({ worker: "publish", traffic: traffic(1000, 9), baseline: { versionId: "v-old", traffic: base } }), { now: NOW, mode: "launch" }).verdicts,
      "gate.availability",
    );
    expect(verdict.p_binomial).toBeGreaterThan(0.01);
    expect(verdict.p_fisher).toBeLessThan(0.01);
    expect(verdict.status).toBe("fail");
  });
  it("does not run the Fisher test below 5 bad events", () => {
    const verdict = gateOf(
      evaluateVersion(inputs({ traffic: traffic(1000, 4), baseline: { versionId: "v-old", traffic: traffic(10_000, 0) } }), { now: NOW, mode: "launch" }).verdicts,
      "gate.availability",
    );
    expect(verdict.p_fisher).toBeNull();
    expect(verdict.status).toBe("pass");
  });
});

describe("decision points", () => {
  it("decides at the floor, then watches until the next doubling", () => {
    const first = evaluateVersion(inputs({ traffic: traffic(300, 0) }), { now: NOW, mode: "launch" });
    expect(gateOf(first.verdicts, "gate.availability").status).toBe("pass");
    expect(first.memory["gate.availability"]).toEqual({ decided_at: 300, last: "pass" });

    const between = evaluateVersion(inputs({ traffic: traffic(450, 3) }), { now: NOW, mode: "launch", memory: first.memory });
    expect(gateOf(between.verdicts, "gate.availability").status).toBe("watching");

    const next = evaluateVersion(inputs({ traffic: traffic(600, 3) }), { now: NOW, mode: "launch", memory: between.memory });
    expect(gateOf(next.verdicts, "gate.availability").status).toBe("pass");
    expect(next.memory["gate.availability"]?.decided_at).toBe(600);
  });

  it("keeps a failure standing until the next decision point clears it", () => {
    const failed = evaluateVersion(inputs({ traffic: traffic(300, 20) }), { now: NOW, mode: "launch" });
    const between = evaluateVersion(inputs({ traffic: traffic(400, 20) }), { now: NOW, mode: "launch", memory: failed.memory });
    expect(gateOf(between.verdicts, "gate.availability").status).toBe("fail");
  });

  it("decides on demand at stage end without spending a decision point", () => {
    const first = evaluateVersion(inputs({ traffic: traffic(300, 0) }), { now: NOW, mode: "launch" });
    const end = evaluateVersion(inputs({ traffic: traffic(450, 30) }), { now: NOW, mode: "launch", memory: first.memory, stageEnd: true });
    expect(gateOf(end.verdicts, "gate.availability").status).toBe("fail");
    expect(end.memory["gate.availability"]).toEqual(first.memory["gate.availability"]);
  });
});

describe("suspect", () => {
  it("flags one principal over 20% of the samples", () => {
    const t = traffic(1000, 0, 100, { ...none, principalSamples: 201 });
    expect(dominantSource(t)).toMatch(/principal_hash/);
    expect(statusOf({ traffic: t }, "gate.availability")).toBe("suspect");
  });
  it("flags one ip over 20% of the samples and over 50% of the bad ones", () => {
    expect(statusOf({ traffic: traffic(1000, 0, 100, { ...none, ipSamples: 201 }) }, "gate.availability")).toBe("suspect");
    expect(statusOf({ traffic: traffic(1000, 2, 100, { ...none, ipBad: 2, ipSamples: 10 }) }, "gate.availability")).toBe("suspect");
  });
  it("leaves 20% and 50% exactly alone", () => {
    expect(dominantSource(traffic(1000, 10, 100, { principalSamples: 200, principalBad: 5, ipSamples: 200, ipBad: 5 }))).toBeNull();
  });
  it("does not stop a gate below its floor", () => {
    expect(statusOf({ traffic: traffic(100, 0, 100, { ...none, principalSamples: 100 }) }, "gate.availability")).toBe("insufficient");
  });
});

describe("latency", () => {
  const status = (t: Traffic, baseline?: Traffic, worker = "web"): GateStatus =>
    statusOf({ worker, traffic: t, baseline: baseline ? { versionId: "v-old", traffic: baseline } : null }, "gate.p99_latency");

  it("waits for 1,000 samples", () => expect(status(traffic(999, 0, 100))).toBe("insufficient"));
  it("passes a read Worker at p95 within 500 ms", () => expect(status(traffic(1000, 0, 500))).toBe("pass"));
  it("fails it above 500 ms, and a write Worker above 1,000 ms", () => {
    expect(status(traffic(1000, 0, 600))).toBe("fail");
    expect(status(traffic(1000, 0, 800), undefined, "publish")).toBe("pass");
    expect(status(traffic(1000, 0, 1250), undefined, "publish")).toBe("fail");
  });
  it("moves from p95 to p99 at 10,000 samples", () => {
    const slowShare = (n: number, share: number): Traffic => {
      const t = traffic(n, 0, 100);
      const slow = Math.round(n * share);
      t.latency[LATENCY_BOUNDS_MS.indexOf(100)] = n - slow;
      t.latency[LATENCY_BOUNDS_MS.indexOf(1000)] = slow;
      return t;
    };
    // 1.5% of requests over the p99 limit is invisible to p95 and fatal to p99.
    expect(status(slowShare(9_999, 0.015))).toBe("pass");
    expect(status(slowShare(10_000, 0.015))).toBe("fail");
    expect(status(slowShare(10_000, 0.005))).toBe("pass");
    expect(status(slowShare(9_999, 0.06))).toBe("fail");
  });
  it("fails at 1.5x the baseline and 100 ms slower, not at either alone", () => {
    expect(status(traffic(2000, 0, 400), traffic(2000, 0, 150))).toBe("fail");
    expect(status(traffic(2000, 0, 150), traffic(2000, 0, 50))).toBe("pass");
    expect(status(traffic(2000, 0, 400), traffic(2000, 0, 300))).toBe("pass");
  });
});

describe("self-test and synthetic", () => {
  it("passes on a fresh ok result, waits on a stale or missing one, fails a failed one", () => {
    expect(statusOf({ selftest: { ok: true, at: NOW - 9 * 60_000 } }, "gate.selftest")).toBe("pass");
    expect(statusOf({ selftest: { ok: true, at: NOW - 11 * 60_000 } }, "gate.selftest")).toBe("insufficient");
    expect(statusOf({}, "gate.selftest")).toBe("insufficient");
    expect(statusOf({ selftest: { ok: false, at: NOW } }, "gate.selftest")).toBe("fail");
  });

  const runs = (...oks: boolean[]) => oks.map((ok, i) => ({ ok, at: NOW + i }));
  it("needs 3 runs", () => expect(statusOf({ syntheticRuns: runs(true, true) }, "gate.synthetic")).toBe("insufficient"));
  it("passes 100% of runs, forgiving one failure the next run passed", () => {
    expect(statusOf({ syntheticRuns: runs(true, true, true) }, "gate.synthetic")).toBe("pass");
    expect(statusOf({ syntheticRuns: runs(true, false, true, true) }, "gate.synthetic")).toBe("pass");
  });
  it("waits on a latest failure and fails two in a row", () => {
    expect(statusOf({ syntheticRuns: runs(true, true, false) }, "gate.synthetic")).toBe("watching");
    expect(statusOf({ syntheticRuns: runs(true, false, false) }, "gate.synthetic")).toBe("fail");
  });
});

describe("domain gates", () => {
  it("hash integrity fails on any mismatch, even below the floor", () => {
    expect(statusOf({ hashMismatches: 1 }, "gate.domain.hash_integrity")).toBe("fail");
    expect(statusOf({ traffic: { ...traffic(0, 0), downloads: 19 } }, "gate.domain.hash_integrity")).toBe("insufficient");
    expect(statusOf({ traffic: { ...traffic(0, 0), downloads: 20 } }, "gate.domain.hash_integrity")).toBe("pass");
  });
  it("index fetch needs every probe fetch verified and the index fresh", () => {
    const f = (ok: boolean, staleS: number | null = 5) => ({ ok, at: NOW, staleS });
    expect(statusOf({ indexFetches: [] }, "gate.domain.index_fetch_success")).toBe("insufficient");
    expect(statusOf({ indexFetches: [f(true), f(true)] }, "gate.domain.index_fetch_success")).toBe("pass");
    expect(statusOf({ indexFetches: [f(true), f(false)] }, "gate.domain.index_fetch_success")).toBe("fail");
    expect(statusOf({ indexFetches: [f(true, 601)] }, "gate.domain.index_fetch_success")).toBe("fail");
  });
  it("publish success reads the dry run, then 98% once 50 publishes have happened", () => {
    const p = { worker: "publish" };
    expect(statusOf(p, "gate.domain.publish_success")).toBe("insufficient");
    expect(statusOf({ ...p, dryRuns: [{ at: NOW, reachedVerdict: true, publishFailed: false }] }, "gate.domain.publish_success")).toBe("pass");
    expect(statusOf({ ...p, dryRuns: [{ at: NOW, reachedVerdict: true, publishFailed: true }] }, "gate.domain.publish_success")).toBe("fail");
    expect(statusOf({ ...p, publishValidated: 49, publishFailed: 0 }, "gate.domain.publish_success")).toBe("insufficient");
    expect(statusOf({ ...p, publishValidated: 50, publishFailed: 0 }, "gate.domain.publish_success")).toBe("pass");
    expect(statusOf({ ...p, publishValidated: 40, publishFailed: 10 }, "gate.domain.publish_success")).toBe("fail");
  });
  it("mcp search watches failures, degradation and p95 over 100 calls", () => {
    const m = { worker: "mcp" };
    expect(statusOf({ ...m, traffic: traffic(99, 0, 100) }, "gate.domain.mcp_search_success")).toBe("insufficient");
    expect(statusOf({ ...m, traffic: traffic(100, 0, 100) }, "gate.domain.mcp_search_success")).toBe("pass");
    expect(statusOf({ ...m, traffic: traffic(100, 0, 100), searchDegraded: 8 }, "gate.domain.mcp_search_success")).toBe("fail");
    expect(statusOf({ ...m, traffic: traffic(100, 0, 600) }, "gate.domain.mcp_search_success")).toBe("fail");
  });
  it("queue backlog holds audit to 5 minutes, the rest to 10, and any new DLQ fails", () => {
    expect(statusOf({}, "gate.queue.backlog")).toBe("insufficient");
    expect(statusOf({ queues: [{ queue: "audit", oldestAgeS: 299 }, { queue: "reindex", oldestAgeS: 599 }] }, "gate.queue.backlog")).toBe("pass");
    expect(statusOf({ queues: [{ queue: "audit", oldestAgeS: 300 }] }, "gate.queue.backlog")).toBe("fail");
    expect(statusOf({ queues: [{ queue: "reindex", oldestAgeS: 600 }] }, "gate.queue.backlog")).toBe("fail");
    expect(statusOf({ queues: [{ queue: "reindex", oldestAgeS: 1 }], dlqRecent: 1 }, "gate.queue.backlog")).toBe("fail");
  });
  it("leaves out a domain gate the Worker does not carry", () => {
    const names = evaluateVersion(inputs({ worker: "admin" }), { now: NOW, mode: "launch" }).verdicts.map((v) => v.gate);
    expect(names).not.toContain("gate.domain.hash_integrity");
    expect(names).not.toContain("gate.domain.mcp_search_success");
    expect(names).toContain("gate.queue.backlog");
  });
});

describe("modes", () => {
  it("makes only the self-test and synthetic gates binding before launch", () => {
    const { verdicts } = evaluateVersion(inputs({ traffic: traffic(300, 0) }), { now: NOW, mode: "pre-launch" });
    expect(verdicts.filter((v) => v.binding).map((v) => v.gate).sort()).toEqual(["gate.selftest", "gate.synthetic"]);
    expect(gateOf(verdicts, "gate.availability").status).toBe("pass");
  });
  it("makes every gate binding at launch", () => {
    expect(evaluateVersion(inputs(), { now: NOW, mode: "launch" }).verdicts.every((v) => v.binding)).toBe(true);
  });
});
