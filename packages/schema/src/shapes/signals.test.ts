import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIGNALS, SIGNAL_NAMES, SignalNameSchema } from "./signals";

// The catalogue in docs/operations/monitoring.md §Signals is the source this list mirrors.
const doc = readFileSync(new URL("../../../../docs/operations/monitoring.md", import.meta.url), "utf8");
const section = doc.slice(doc.indexOf("## Signals"), doc.indexOf("Datasets:"));

function documentedSignals(): string[] {
  const names: string[] = [];
  // Bullets read "- **area**: `a`, `b`. **area2**: `c`." and may wrap lines.
  const flat = section.replace(/\n\s+/g, " ");
  for (const m of flat.matchAll(/\*\*([a-z]+)\*\*:([^*]*?)(?=\*\*|\n|$)/g)) {
    for (const e of m[2]!.matchAll(/`([a-z_]+)`/g)) names.push(`${m[1]}.${e[1]}`);
  }
  return names;
}

describe("signals catalogue", () => {
  it("matches monitoring.md in both directions", () => {
    const documented = documentedSignals().sort();
    expect(documented.length).toBeGreaterThan(50);
    expect([...SIGNAL_NAMES].sort()).toEqual(documented);
  });
  it("names are <area>.<past-tense event> and unique", () => {
    expect(new Set(SIGNAL_NAMES).size).toBe(SIGNAL_NAMES.length);
    expect(Object.keys(SIGNALS).length).toBeGreaterThan(20);
  });
  it("validates names", () => {
    expect(SignalNameSchema.safeParse("index.root_signed").success).toBe(true);
    expect(SignalNameSchema.safeParse("index.nonsense").success).toBe(false);
  });
});
