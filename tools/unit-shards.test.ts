import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");

function workspaceDirs(): string[] {
  const patterns = [...readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8").matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]);
  return patterns.flatMap((pattern) =>
    pattern.endsWith("/*")
      ? readdirSync(join(REPO, pattern.slice(0, -2)), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(pattern.slice(0, -2), e.name))
      : [pattern],
  );
}

// The unit shards pass `--shard` to every package's test script, and vitest's split puts each file
// in exactly one shard only when that script is a plain `vitest run` it can append the flag to.
describe("unit shards", () => {
  it("shards every workspace package's tests through a plain vitest run", () => {
    const scripts = workspaceDirs()
      .filter((dir) => existsSync(join(REPO, dir, "package.json")))
      .map((dir) => [dir, (JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8")) as { scripts?: { test?: string } }).scripts?.test] as const)
      .filter(([, test]) => test !== undefined);
    expect(scripts.length).toBeGreaterThan(0);
    for (const [dir, test] of scripts) expect([dir, test]).toEqual([dir, "vitest run"]);
  });

  it("runs every shard of the matrix against all packages", () => {
    const yml = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    const unit = yml.slice(yml.indexOf("\n  unit:\n"), yml.indexOf("\n  infra:\n"));
    expect(unit).toContain('TOTAL: ${{ strategy.job-total }}');
    expect(unit).toContain('turbo run test --only -- --shard="$SHARD/$TOTAL"');
    expect(unit).not.toContain("--filter");
  });
});
