import { describe, expect, it } from "vitest";
import { addHistograms, binomialUpperTail, emptyHistogram, fisherUpperTail, histogramPercentile, latestDecisionPoint, LATENCY_BOUNDS_MS, lnGamma, shareAbove } from "../stats";

/** Straight pmf recurrence in double precision: slower and less general than the code under test, and independent of it. */
function referenceBinomialTail(bad: number, n: number, p: number): number {
  let pmf = (1 - p) ** n;
  let sum = bad === 0 ? pmf : 0;
  for (let i = 1; i <= n; i++) {
    pmf *= ((n - i + 1) / i) * (p / (1 - p));
    if (i >= bad) sum += pmf;
  }
  return sum;
}

describe("exact tests", () => {
  it("computes lnGamma at known points", () => {
    expect(lnGamma(1)).toBeCloseTo(0, 12);
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
  });

  it("matches the textbook binomial tail", () => {
    expect(binomialUpperTail(1, 10, 0.5)).toBeCloseTo(1 - 1 / 1024, 12);
    expect(binomialUpperTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 12);
    expect(binomialUpperTail(0, 10, 0.5)).toBe(1);
    expect(binomialUpperTail(11, 10, 0.5)).toBe(0);
  });

  it("agrees with the reference on the gate table's operating points", () => {
    for (const [bad, n, p] of [[5, 300, 0.005], [6, 300, 0.005], [9, 300, 0.01], [40, 10_000, 0.005], [101, 10_000, 0.005], [3, 100, 0.01], [8, 50, 0.02]] as const) {
      expect(binomialUpperTail(bad, n, p) / referenceBinomialTail(bad, n, p)).toBeCloseTo(1, 8);
    }
  });

  it("matches the textbook Fisher table", () => {
    expect(fisherUpperTail(3, 4, 1, 4)).toBeCloseTo(17 / 70, 12);
    expect(fisherUpperTail(4, 4, 0, 4)).toBeCloseTo(1 / 70, 12);
    expect(fisherUpperTail(0, 4, 3, 4)).toBe(1);
  });

  it("finds an equal pair unremarkable and a tenfold worse candidate not", () => {
    expect(fisherUpperTail(10, 1000, 10, 1000)).toBeGreaterThan(0.4);
    expect(fisherUpperTail(30, 1000, 3, 1000)).toBeLessThan(0.01);
  });
});

describe("decision points", () => {
  it("are the floor and each doubling", () => {
    expect(latestDecisionPoint(299, 300)).toBeNull();
    expect(latestDecisionPoint(300, 300)).toBe(300);
    expect(latestDecisionPoint(599, 300)).toBe(300);
    expect(latestDecisionPoint(600, 300)).toBe(600);
    expect(latestDecisionPoint(2500, 300)).toBe(2400);
  });
});

describe("latency histogram", () => {
  const at = (ms: number, count: number): number[] => {
    const h = emptyHistogram();
    h[LATENCY_BOUNDS_MS.findIndex((b) => ms <= b)] = count;
    return h;
  };

  it("reads a percentile inside its bucket", () => {
    expect(histogramPercentile(emptyHistogram(), 0.95)).toBeNull();
    expect(histogramPercentile(at(500, 100), 0.5)).toBeCloseTo(450, 5);
  });

  it("counts the share above a bound exactly", () => {
    const h = addHistograms(at(100, 940), at(800, 60));
    expect(shareAbove(h, 500)).toBeCloseTo(0.06, 12);
    expect(shareAbove(h, 800)).toBe(0);
    expect(() => shareAbove(h, 501)).toThrow();
  });
});
