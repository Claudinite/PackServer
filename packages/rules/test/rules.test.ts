import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRules, RULES_VERSIONS } from "../src/index";

const checkTool = new URL("../../../tools/check-rules.mjs", import.meta.url).pathname;
const rulesDir = new URL("..", import.meta.url).pathname;

describe("loadRules", () => {
  const rules = loadRules("2026.10.1");

  it("returns one deeply frozen version object", () => {
    expect(rules.version).toBe("2026.10.1");
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules.score.parts)).toBe(true);
    expect(Object.isFrozen(rules.staticRules.rules[0])).toBe(true);
    expect(loadRules("2026.10.1")).toBe(rules);
  });

  it("carries the A6 weights and D34 caps", () => {
    expect(rules.score.parts).toEqual({
      context_cost: 25,
      skill_structure: 25,
      checks: 20,
      source: 15,
      footprint: 15,
    });
    expect(rules.score.caps).toEqual({ published_advisory: 40, no_public_repo: 70 });
  });

  it("names the static-only prose screen and versions every file", () => {
    expect(rules.proseScreen).toBe("static-only");
    for (const file of [rules.staticRules, rules.score, rules.questions, rules.thresholds]) {
      expect(file.version).toBe("2026.10.1");
    }
  });

  it("refuses an unknown version", () => {
    expect(() => loadRules("1999.1.1")).toThrow(/unknown rules version/);
  });

  it("lists every version it can load", () => {
    expect(RULES_VERSIONS).toContain("2026.10.1");
  });
});

describe("check-rules", () => {
  function run(dir: string) {
    return spawnSync("node", [checkTool, dir], { encoding: "utf8" });
  }

  function mutated(edit: (rules: { rules: Array<Record<string, unknown>> }) => void) {
    const dir = mkdtempSync(join(tmpdir(), "rules-"));
    cpSync(join(rulesDir, "2026.10.1"), join(dir, "2026.10.1"), { recursive: true });
    const file = join(dir, "2026.10.1", "static-rules.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    edit(data);
    writeFileSync(file, JSON.stringify(data));
    return dir;
  }

  it("passes on the shipped data", () => {
    const result = run(rulesDir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects a security rule classed warn", () => {
    const dir = mutated((d) => {
      const rule = d.rules.find((r) => r.category === "credentials")!;
      rule.class = "warn";
    });
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/never warn/);
  });

  it("rejects a rule with an unknown class or a duplicate id", () => {
    const dir = mutated((d) => {
      d.rules[0]!.class = "block";
      d.rules.push({ ...d.rules[1]! });
    });
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/class/);
    expect(result.stderr).toMatch(/duplicate/);
  });
});
