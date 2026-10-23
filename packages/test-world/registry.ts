import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./root.ts";

export interface SpecTest {
  id: string;
  title: string;
  covers: string[];
  runs: string;
}

export interface Specs {
  /** Every id in the register, whatever its status: a retired id still tags an old test. */
  requirements: Array<{ id: string; title: string }>;
  tests: Map<string, SpecTest>;
}

const REQ = /REQ-[A-Z]+-\d{3}/g;
let cached: Specs | undefined;

/** Reads the register and the test specs the way `docs/testing/coverage.mjs` does. */
export function loadSpecs(root = REPO_ROOT): Specs {
  if (cached && root === REPO_ROOT) return cached;
  const requirements: Specs["requirements"] = [];
  const reqDir = join(root, "docs/requirements");
  for (const file of readdirSync(reqDir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    for (const line of readFileSync(join(reqDir, file), "utf8").split("\n")) {
      const h = /^## (REQ-[A-Z]+-\d{3}) (.*)$/.exec(line);
      if (h) requirements.push({ id: h[1]!, title: h[2]!.trim() });
    }
  }
  const tests = new Map<string, SpecTest>();
  const testDir = join(root, "docs/testing");
  for (const file of readdirSync(testDir).filter((f) => f.endsWith(".md") && !["README.md", "coverage.md"].includes(f))) {
    let current: SpecTest | undefined;
    for (const line of readFileSync(join(testDir, file), "utf8").split("\n")) {
      const h = /^### ((?:IT-[A-Z]+|JT)-\d{3}) (.*)$/.exec(line);
      if (h) {
        current = { id: h[1]!, title: h[2]!.trim(), covers: [], runs: "" };
        tests.set(current.id, current);
        continue;
      }
      if (/^## /.test(line)) current = undefined;
      if (!current) continue;
      const covers = /^- \*\*Covers:\*\* (.*)$/.exec(line);
      if (covers) current.covers = covers[1]!.match(REQ) ?? [];
      const runs = /^- \*\*Runs:\*\* (.*)$/.exec(line);
      if (runs) current.runs = runs[1]!.trim();
    }
  }
  const specs = { requirements, tests };
  if (root === REPO_ROOT) cached = specs;
  return specs;
}
