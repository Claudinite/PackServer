import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const WEIGHTS_URL = new URL("./shard-weights.json", import.meta.url);

/** Heaviest first onto the lightest shard, so the same files always land on the same shard. A file with no weight counts as the median one. */
export function assignShards(files: string[], weights: Record<string, number>, count: number): string[][] {
  const known = Object.values(weights).sort((a, b) => a - b);
  const fallback = known[known.length >> 1] ?? 1;
  const weigh = (f: string) => weights[f] ?? fallback;
  const bins = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  for (const f of [...files].sort((a, b) => weigh(b) - weigh(a) || a.localeCompare(b))) {
    const bin = bins.reduce((lightest, b) => (b.load < lightest.load ? b : lightest));
    bin.load += weigh(f);
    bin.files.push(f);
  }
  return bins.map((b) => b.files);
}

/** Splits files across `--shard` by their recorded duration instead of by a hash of the path. */
export default class DurationSequencer extends BaseSequencer {
  private name(spec: TestSpecification): string {
    return relative(this.ctx.config.root, spec.moduleId).split("\\").join("/");
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const weights = JSON.parse(readFileSync(WEIGHTS_URL, "utf8")) as Record<string, number>;
    const mine = new Set(assignShards(files.map((s) => this.name(s)), weights, count)[index - 1]);
    return files.filter((s) => mine.has(this.name(s)));
  }
}
