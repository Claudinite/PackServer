import { emptyHistogram, evaluateVersion, type Traffic, type VersionInputs, type VersionMemory } from "@packserver/core/gates";

/** Seeded so a re-run after a threshold change compares like with like. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const traffic = (samples: number, bad: number): Traffic => {
  const latency = emptyHistogram();
  latency[2] = samples;
  return { samples, bad, downloads: 0, latency, top: { principalSamples: 0, principalBad: 0, ipSamples: 0, ipBad: 0, baseSamples: samples, baseBad: bad } };
};

export interface Outcome {
  rate: number;
  trials: number;
  /** Trials in which `gate.availability` failed at some decision point before the stage ended. */
  failed: number;
  failedWithBaseline: number;
}

/**
 * A stage of `stageSamples` requests arriving a cycle's worth at a time, the judge evaluating after
 * each batch exactly as its cron does, against a baseline that fails at `baselineRate`.
 */
export function simulateAvailability(options: { worker: string; rate: number; baselineRate: number; trials: number; seed: number; stageSamples?: number; batch?: number }): Outcome {
  const { worker, rate, baselineRate, trials, seed, stageSamples = 10_000, batch = 100 } = options;
  const random = mulberry32(seed);
  let failed = 0;
  let failedWithBaseline = 0;
  for (const withBaseline of [false, true]) {
    for (let t = 0; t < trials; t++) {
      let n = 0;
      let bad = 0;
      let memory: VersionMemory = {};
      let sawFail = false;
      while (n < stageSamples && !sawFail) {
        for (let i = 0; i < batch; i++) bad += random() < rate ? 1 : 0;
        n += batch;
        const base = traffic(100_000, Math.round(100_000 * baselineRate));
        const input: VersionInputs = {
          versionId: "v", worker, traffic: traffic(n, bad), baseline: withBaseline ? { versionId: "b", traffic: base } : null,
          selftest: null, syntheticRuns: [], indexFetches: [], dryRuns: [], hashMismatches: 0, publishValidated: 0, publishFailed: 0, searchDegraded: 0, queues: [], dlqRecent: 0,
        };
        const result = evaluateVersion(input, { now: 0, mode: "launch", memory });
        memory = result.memory;
        sawFail = result.verdicts.find((v) => v.gate === "gate.availability")?.status === "fail";
      }
      if (sawFail && withBaseline) failedWithBaseline++;
      else if (sawFail) failed++;
    }
  }
  return { rate, trials, failed, failedWithBaseline };
}
