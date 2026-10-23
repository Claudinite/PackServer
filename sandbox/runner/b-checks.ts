import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tree } from "@packserver/core/canonical";
import { readFile } from "@packserver/core/canonical";
import { ENGINE_CONTRACT, type Release } from "./b-engine.ts";
import { B_LIMITS } from "./b-limits.ts";
import { exec, scrubbedEnv } from "./b-exec.ts";
import { clean, type SandboxBReport } from "./b-report.ts";

type Compile = SandboxBReport["compile"][number];
type Declared = SandboxBReport["declared"][number];

const CHECK_FILE = /^checks\/[A-Za-z0-9._-]+\.go$/;
const DECLARED_FILE = /^(declared-checks\.json|skills\/[A-Za-z0-9._-]+\/declared-checks\.json)$/;
const ON_FAIL = new Set(["advise", "block"]);

export const codedChecks = (tree: Tree) => tree.files.filter((f) => CHECK_FILE.test(f.path) && !f.path.endsWith("_test.go")).map((f) => f.path);

/**
 * Compiles every `checks/*.go` as one package against the release's check SDK, offline. The Go
 * toolchain reports errors per file, so a failure is attributed to the files it names; a file the
 * toolchain did not name compiled. Null when the pack has checks but the release carries no SDK.
 */
export async function compileChecks(tree: Tree, release: Release, work: string, home: string, onSpawn: (pgid: number) => void): Promise<Compile[] | null> {
  const files = codedChecks(tree);
  if (!files.length) return [];
  if (!release.sdk) return null;
  const module = join(work, "checks-module");
  await mkdir(join(module, "checks"), { recursive: true });
  await writeFile(
    join(module, "go.mod"),
    `module packchecks\n\ngo 1.24\n\nrequire ${ENGINE_CONTRACT.sdkModule} v0.0.0\n\nreplace ${ENGINE_CONTRACT.sdkModule} => ${release.sdk}\n`,
  );
  for (const f of files) await writeFile(join(module, f), readFile(tree, f)!.content);
  const result = await exec({ cmd: "go", args: ["build", "-o", "/dev/null", "./checks"], cwd: module, env: scrubbedEnv(home), timeoutMs: B_LIMITS.stepMs, onSpawn });
  if (result.timedOut) return files.map((file) => ({ file, status: "timeout", message: null }));
  if (result.exitCode === 0) return files.map((file) => ({ file, status: "compiled", message: null }));
  const failures = new Map<string, string>();
  for (const line of result.output.split("\n")) {
    const m = /^(?:\.\/)?(checks\/[A-Za-z0-9._-]+\.go):\d+(?::\d+)?:\s*(.+)$/.exec(line.trim());
    if (m && !failures.has(m[1]!)) failures.set(m[1]!, clean(m[2]!));
  }
  // Failures the toolchain could not tie to a file (a missing import, a bad module) fail the package as a whole.
  if (!failures.size) return files.map((file) => ({ file, status: "failed", message: clean(result.output) || null }));
  return files.map((file) => (failures.has(file) ? { file, status: "failed", message: failures.get(file)! } : { file, status: "compiled", message: null }));
}

/** `declared-checks.json` is a list of entries each naming an id and what a failure does. */
export function parseDeclared(tree: Tree): Declared[] {
  const out: Declared[] = [];
  for (const f of tree.files.filter((x) => DECLARED_FILE.test(x.path))) {
    let problem: string | null = null;
    try {
      const data: unknown = JSON.parse(new TextDecoder().decode(f.content));
      if (!Array.isArray(data)) problem = "the file is not a list of checks";
      else {
        const ids = new Set<string>();
        data.forEach((entry: unknown, i) => {
          if (problem) return;
          const e = entry as { id?: unknown; on_fail?: unknown } | null;
          if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id) problem = `entry ${i + 1} has no id`;
          else if (ids.has(e.id)) problem = `entry ${i + 1} repeats the id ${clean(e.id).slice(0, 80)}`;
          else if (typeof e.on_fail !== "string" || !ON_FAIL.has(e.on_fail)) problem = `entry ${i + 1} has no valid on_fail`;
          else ids.add(e.id);
        });
      }
    } catch {
      problem = "the file is not valid JSON";
    }
    out.push({ file: f.path, status: problem ? "failed" : "parsed", message: problem });
  }
  return out;
}

