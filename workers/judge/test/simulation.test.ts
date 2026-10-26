import { describe, expect, it } from "vitest";
import { simulateAvailability } from "./simulation";

/**
 * Re-run on every threshold or alpha change: `SIMULATE=1 pnpm --filter @packserver/worker-judge test simulation`
 * prints the table. The bounds below are what the table's thresholds and alpha 0.01 should deliver.
 */
const TRIALS = 400;
const run = (rate: number, baselineRate: number, worker = "web") => simulateAvailability({ worker, rate, baselineRate, trials: TRIALS, seed: 7 });

describe("gate.availability over a 10,000-request stage", () => {
  const rows = [0.001, 0.002, 0.005, 0.01, 0.015, 0.02].map((rate) => run(rate, 0.005));

  it("prints the operating characteristic when asked", () => {
    if (process.env.SIMULATE) {
      console.info("rate    fail%   fail% (vs 0.5% baseline)");
      for (const r of rows) console.info(`${(r.rate * 100).toFixed(1)}%   ${((100 * r.failed) / r.trials).toFixed(1)}%   ${((100 * r.failedWithBaseline) / r.trials).toFixed(1)}%`);
    }
    expect(rows).toHaveLength(6);
  });

  it("almost never fails a version well inside the threshold", () => {
    expect(rows[0]?.failed).toBe(0);
    expect((rows[1]?.failed ?? 0) / TRIALS).toBeLessThan(0.01);
  });

  it("keeps a version exactly at the threshold to the sequential-testing allowance of about one alpha per decision point", () => {
    // Decision points at 300, 600, 1,200, 2,400, 4,800, 9,600: six looks at alpha 0.01.
    expect((rows[2]?.failed ?? 0) / TRIALS).toBeLessThan(0.07);
  });

  it("catches a version at twice the threshold nearly every time, and at four times always", () => {
    expect((rows[3]?.failed ?? 0) / TRIALS).toBeGreaterThan(0.9);
    expect((rows[5]?.failed ?? 0) / TRIALS).toBeGreaterThan(0.99);
  });

  it("does not let a baseline that is equally bad make a version fail more often than the threshold alone", () => {
    for (const r of rows) expect(r.failedWithBaseline).toBeLessThanOrEqual(r.failed + 8);
  });
});
