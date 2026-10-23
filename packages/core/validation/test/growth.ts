import { expect } from "vitest";
import { runStaticRules } from "../index.ts";
import { cleanFiles, fakePorts, input } from "./helpers.ts";

export type Files = Record<string, string | Uint8Array>;
const KIB = 1024;
// The fastest of a few runs is the one least disturbed by a busy machine.
const fastest = (xs: number[]) => Math.min(...xs);

async function timeOf(files: (size: number) => Files, size: number): Promise<number> {
  const t = performance.now();
  await runStaticRules(input({ ...cleanFiles(), ...(files as unknown as (size: number) => Record<string, string>)(size) }), fakePorts());
  return performance.now() - t;
}

/**
 * Linear growth makes 2 MiB take about sixteen times as long as 128 KiB; a quadratic scan takes about 256 times.
 * Comparing sizes on the same machine keeps a loaded runner from failing a correct scan. The sizes run in order
 * and a single run over five seconds at 512 KiB or less stops there, so a badly quadratic scan fails at a small size instead of
 * running for minutes at the large one.
 */
export async function expectLinear(files: (size: number) => Files): Promise<void> {
  await timeOf(files, 8 * KIB);
  const sizes = [128, 512, 2048];
  const runs = [4, 2, 2];
  const best: number[] = [];
  for (const [k, size] of sizes.entries()) {
    const times: number[] = [];
    for (let r = 0; r < runs[k]!; r++) {
      times.push(await timeOf(files, size * KIB));
      if (size <= 512) expect(times[r], `one run took too long at ${size} KiB`).toBeLessThan(5_000);
    }
    best.push(fastest(times));
  }
  expect(best[2]! / Math.max(best[0]!, 2), `${best[0]!.toFixed(0)} ms at 128 KiB, ${best[2]!.toFixed(0)} ms at 2 MiB`).toBeLessThan(64);
}
