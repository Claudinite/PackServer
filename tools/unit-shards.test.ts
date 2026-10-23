import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
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

  // The shards pass `--passWithNoTests`, so a package whose include pattern stops matching would
  // otherwise pass silently in both.
  it("finds at least one test file in every package with a test script", async () => {
    const dirs = workspaceDirs().filter((dir) => {
      const manifest = join(REPO, dir, "package.json");
      return existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: { test?: string } }).scripts?.test !== undefined;
    });
    const listed = await Promise.all(
      dirs.map(async (dir) => {
        const { stdout } = await run("pnpm", ["exec", "vitest", "list", "--filesOnly"], { cwd: join(REPO, dir) }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
        return [dir, stdout.split("\n").filter((line) => /\.(test|spec)\./.test(line)).length > 0] as const;
      }),
    );
    expect(listed.filter(([, found]) => !found).map(([dir]) => dir)).toEqual([]);
  }, 120_000);

  it("runs every shard of the matrix against all packages", () => {
    const yml = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    const unit = yml.slice(yml.indexOf("\n  unit:\n"), yml.indexOf("\n  infra:\n"));
    expect(unit).toContain('TOTAL: ${{ strategy.job-total }}');
    expect(unit).toContain('turbo run test --only -- --shard="$SHARD/$TOTAL"');
    expect(unit).not.toContain("--filter");
  });
});
