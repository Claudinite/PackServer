import { expect } from "vitest";
import { runStaticRules } from "../index.ts";
import { cleanFiles, fakePorts, input } from "./helpers.ts";

export type Files = Record<string, string | Uint8Array>;
const KIB = 1024;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function timeOf(files: (size: number) => Files, size: number): Promise<number> {
  const t = performance.now();
  await runStaticRules(input({ ...cleanFiles(), ...(files(size) as Record<string, string>) }), fakePorts());
  return performance.now() - t;
}

/**
 * A scan that is linear takes about eight times as long at 1 MiB as at 128 KiB; a quadratic one takes sixty-four times.
 * Comparing the two sizes on the same machine keeps a loaded runner from failing a correct scan, and a coarse
 * absolute cap still catches a scan that is simply slow.
 */
export async function expectLinear(files: (size: number) => Files): Promise<void> {
  await timeOf(files, 16 * KIB);
  const small: number[] = [];
  const large: number[] = [];
  for (let k = 0; k < 3; k++) {
    small.push(await timeOf(files, 128 * KIB));
    large.push(await timeOf(files, 1024 * KIB));
  }
  const ratio = median(large) / Math.max(median(small), 40);
  expect(ratio, `${median(small).toFixed(0)} ms at 128 KiB, ${median(large).toFixed(0)} ms at 1 MiB`).toBeLessThan(24);
  expect(median(large)).toBeLessThan(10_000);
}
