/** Natural log of the gamma function (Lanczos, g = 7), accurate to about 1e-14 for the arguments used here. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0] as number;
  for (let i = 1; i < LANCZOS.length; i++) sum += (LANCZOS[i] as number) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

const lnChoose = (n: number, k: number): number => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);

/** Sums pmf(i) for i = from..to, stopping once the terms are past their mode and no longer move the sum. */
function tail(from: number, to: number, mode: number, logPmf: (i: number) => number): number {
  let sum = 0;
  for (let i = from; i <= to; i++) {
    const term = Math.exp(logPmf(i));
    sum += term;
    if (i > mode && term < sum * 1e-17) break;
  }
  return Math.min(1, sum);
}

/** One-sided exact binomial test: P(X >= bad) for X ~ Binomial(n, p). */
export function binomialUpperTail(bad: number, n: number, p: number): number {
  if (bad <= 0) return 1;
  if (bad > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  return tail(bad, n, Math.floor((n + 1) * p), (i) => lnChoose(n, i) + i * lp + (n - i) * lq);
}

/**
 * One-sided Fisher exact test: the chance a candidate with `n1` samples has at least `bad1` bad ones
 * when the bad events of both versions (`bad1 + bad2` of `n1 + n2`) fall on the samples at random.
 */
export function fisherUpperTail(bad1: number, n1: number, bad2: number, n2: number): number {
  const total = n1 + n2;
  const bad = bad1 + bad2;
  if (bad1 <= 0) return 1;
  const top = Math.min(bad, n1);
  if (bad1 > top) return 0;
  const denominator = lnChoose(total, n1);
  const mode = Math.floor(((n1 + 1) * (bad + 1)) / (total + 2));
  return tail(bad1, top, mode, (i) => lnChoose(bad, i) + lnChoose(total - bad, n1 - i) - denominator);
}

/** The sample counts at which a proportion gate decides: the floor, then each doubling. */
export function latestDecisionPoint(samples: number, floor: number): number | null {
  if (samples < floor) return null;
  let point = floor;
  while (point * 2 <= samples) point *= 2;
  return point;
}

/** Upper bounds, in milliseconds, of the latency histogram the judge reads; one more count sits above the last. */
export const LATENCY_BOUNDS_MS = [25, 50, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1250, 1500, 2000, 3000, 5000] as const;

export type LatencyHistogram = number[];

export const emptyHistogram = (): LatencyHistogram => new Array<number>(LATENCY_BOUNDS_MS.length + 1).fill(0);

export function addHistograms(a: LatencyHistogram, b: LatencyHistogram): LatencyHistogram {
  return a.map((count, i) => count + (b[i] ?? 0));
}

const total = (h: LatencyHistogram): number => h.reduce((a, b) => a + b, 0);

/** The share of samples slower than `limitMs`, which must be one of the bounds so the answer is exact. */
export function shareAbove(h: LatencyHistogram, limitMs: number): number {
  const at = LATENCY_BOUNDS_MS.indexOf(limitMs as (typeof LATENCY_BOUNDS_MS)[number]);
  if (at < 0) throw new Error(`${limitMs} ms is not a histogram bound`);
  const n = total(h);
  return n === 0 ? 0 : h.slice(at + 1).reduce((a, b) => a + b, 0) / n;
}

/** A percentile read off the histogram by linear interpolation inside its bucket; the open bucket answers its lower bound. */
export function histogramPercentile(h: LatencyHistogram, q: number): number | null {
  const n = total(h);
  if (n === 0) return null;
  const rank = q * n;
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    const count = h[i] as number;
    if (count > 0 && seen + count >= rank) {
      const low = i === 0 ? 0 : (LATENCY_BOUNDS_MS[i - 1] as number);
      const high = LATENCY_BOUNDS_MS[i];
      return high === undefined ? low : low + ((rank - seen) / count) * (high - low);
    }
    seen += count;
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1] as number;
}
