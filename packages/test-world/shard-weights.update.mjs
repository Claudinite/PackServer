// Rewrites shard-weights.json from vitest JUnit reports: node shard-weights.update.mjs reports/scenarios-*.xml
import { readFileSync, writeFileSync } from "node:fs";

const weights = {};
for (const path of process.argv.slice(2)) {
  for (const m of readFileSync(path, "utf8").matchAll(/<testsuite name="([^"]+)"[^>]*\btime="([\d.]+)"/g)) weights[m[1]] = Math.round(Number(m[2]));
}
if (Object.keys(weights).length === 0) throw new Error("no test suites found in the given reports");
const sorted = Object.fromEntries(Object.entries(weights).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(new URL("./shard-weights.json", import.meta.url), JSON.stringify(sorted, null, 1) + "\n");
