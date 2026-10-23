import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalise, extractArchive, readFile, sha256Hex, type Tree } from "@packserver/core/canonical";
import { compareThreePart, isThreePart } from "@packserver/core/validation";
import { compileChecks, parseDeclared } from "./b-checks.ts";
import { loadPack, makeFixtureRepo, unpackRelease, vendorDir, type Release } from "./b-engine.ts";
import { exec, packEnv, type Runtime } from "./b-exec.ts";
import { makeDir, openForTraversal } from "./b-isolation.ts";
import { inventoryOf } from "./b-inventory.ts";
import { B_LIMITS } from "./b-limits.ts";
import { bErrorReport, clean, emptyBReport, fitToBCap, SandboxBReport, type BReportBase } from "./b-report.ts";

export interface EngineInput {
  role: "newest" | "lowest";
  version: string;
  /** The digest the registry pinned; the tarball must hash to it. */
  sha256: string;
  tgz: Uint8Array;
}

export interface BRunInput {
  pack: string;
  canonical: Uint8Array;
  expectedTreeHash: string;
  minEngineVersion: string;
  oldestInMirror: string;
  engines: EngineInput[];
}

export interface BHooks {
  imageDigest: string | null;
  /** Called with each report as it grows, so a supervisor that has to cut the run short still reports what was seen. */
  onProgress?: (report: SandboxBReport) => void;
  onExtracting?: () => void;
  onExtracted?: () => void;
  onSpawn?: (pgid: number) => void;
  /** Overrides the 30 s step cap in tests. */
  stepMs?: number;
  /** The egress recorders and the identity pack content runs as. */
  runtime?: Runtime;
}

const ENV_SETUP_DIR = /^[A-Za-z0-9._/-]{1,100}$/;

/**
 * Validation-pipeline step 8 over one canonical archive. Pack content is compiled, loaded and run
 * only after the archive has extracted to the committed tree hash, and only in child processes:
 * nothing a pack writes reaches this process except an exit status, a bounded output head and the
 * egress file the preload writes.
 */
export async function runB(input: BRunInput, hooks: BHooks): Promise<SandboxBReport> {
  const started = Date.now();
  const base: BReportBase = { imageDigest: hooks.imageDigest, expectedTreeHash: input.expectedTreeHash, minEngineVersion: input.minEngineVersion, oldestInMirror: input.oldestInMirror };
  const elapsed = () => Date.now() - started;
  const stepMs = hooks.stepMs ?? B_LIMITS.stepMs;
  const onSpawn = hooks.onSpawn ?? (() => {});
  let report = emptyBReport(base);
  const publish = () => hooks.onProgress?.(report);

  if (!isThreePart(input.minEngineVersion) || !isThreePart(input.oldestInMirror)) return bErrorReport(base, "input_invalid", { extract: null, total: elapsed() });

  let tree: Tree;
  hooks.onExtracting?.();
  try {
    tree = await extractArchive(input.canonical, { canonical: true });
  } catch {
    return bErrorReport(base, "extract_failed", { extract: elapsed(), total: elapsed() });
  }
  const extractMs = elapsed();
  hooks.onExtracted?.();
  const found = canonicalise(tree).treeHash;
  report = { ...report, tree: { expected: input.expectedTreeHash, found, matches: found === input.expectedTreeHash }, timings_ms: { extract: extractMs, total: elapsed() } };
  // REQ-VAL-051: nothing below this line runs unless the archive is the committed one.
  if (!report.tree.matches) return { ...report, outcome: "error", error: "tree_hash_mismatch" };
  report = { ...report, ...inventoryOf(tree) };
  publish();

  if (compareThreePart(input.minEngineVersion, input.oldestInMirror) < 0) {
    return { ...report, outcome: "ok", min_engine: { ...report.min_engine, supported: false }, timings_ms: { extract: extractMs, total: elapsed() } };
  }
  for (const e of input.engines) if (sha256Hex(e.tgz) !== e.sha256) return { ...report, outcome: "error", error: "engine_digest_mismatch" };

  const runtime: Runtime = hooks.runtime ?? { preloadUrl: new URL("./b-preload.mjs", import.meta.url).href };
  const work = await mkdtemp(join(tmpdir(), "b-run-"));
  const home = join(work, "home");
  await openForTraversal(work);
  await makeDir(home, runtime.user);
  const egressSeen: SandboxBReport["egress"] = [];
  const note = (run: string, lines: string[]) => egressSeen.push(...parseEgress(lines, run));
  try {
    const releases: { engine: EngineInput; release: Release; repo: string }[] = [];
    for (const [i, engine] of [...input.engines].sort((a, b) => (a.role === "newest" ? -1 : 1) - (b.role === "newest" ? -1 : 1)).entries()) {
      const tgz = join(work, `engine-${i}.tgz`);
      await writeFile(tgz, engine.tgz);
      const release = await unpackRelease(tgz, join(work, `engine-${i}`), work);
      if (!release) return { ...report, outcome: "error", error: "engine_unpack_failed" };
      releases.push({ engine, release, repo: join(work, `repo-${i}`) });
    }

    // From here on pack content is compiled and run.
    report = { ...report, pack_code_executed: true };
    publish();
    for (const { engine, release, repo } of releases) {
      await makeFixtureRepo(repo, input.pack, tree, release, runtime);
      const load = await loadPack(repo, release, input.pack, home, runtime, onSpawn);
      note(`load-${engine.role}`, load.egressLines);
      report = {
        ...report,
        engines: [...report.engines, { role: engine.role, version: engine.version, digest_verified: true, load: { status: load.status, exit_code: load.exitCode, file: load.file, message: load.message } }],
      };
      publish();
    }

    const primary = releases[0]!;
    const compiled = await compileChecks(tree, primary.release, work, home, runtime, onSpawn);
    if (!compiled) return { ...report, outcome: "error", error: "sdk_missing", timings_ms: { extract: extractMs, total: elapsed() } };
    note("compile", compiled.egressLines);
    report = { ...report, compile: compiled.results, declared: [...parseDeclared(tree), ...parseTasks(tree)] };
    publish();

    const loaded = report.engines[0]?.load.status === "loaded";
    const runs = await runContent(tree, input.pack, primary.repo, home, loaded, stepMs, onSpawn, runtime, note);
    report = { ...report, runs, egress: egressSeen.slice(0, B_LIMITS.egress), egress_total: egressSeen.length, egress_truncated: egressSeen.length > B_LIMITS.egress };
    report = { ...report, outcome: "ok", timings_ms: { extract: extractMs, total: elapsed() } };
    const fitted = fitToBCap(report);
    return SandboxBReport.parse(fitted ?? bErrorReport(base, "report_over_cap", { extract: extractMs, total: elapsed() }));
  } finally {
    // Best effort: the runner may not be allowed into directories the pack identity owns, and the container is destroyed after the run.
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function parseTasks(tree: Tree): SandboxBReport["declared"] {
  return tree.files
    .filter((f) => /^tasks\/[A-Za-z0-9._-]+\/task\.json$/.test(f.path))
    .map((f) => {
      try {
        const data: unknown = JSON.parse(new TextDecoder().decode(f.content));
        return typeof data === "object" && data !== null && !Array.isArray(data) && typeof (data as { id?: unknown }).id === "string"
          ? { file: f.path, status: "parsed" as const, message: null }
          : { file: f.path, status: "failed" as const, message: "task.json has no id" };
      } catch {
        return { file: f.path, status: "failed" as const, message: "the file is not valid JSON" };
      }
    });
}

type Run = SandboxBReport["runs"][number];

async function runContent(tree: Tree, pack: string, repo: string, home: string, allowed: boolean, stepMs: number, onSpawn: (pgid: number) => void, runtime: Runtime, note: (run: string, lines: string[]) => void): Promise<Run[]> {
  const packRoot = vendorDir(pack);
  const planned: { kind: Run["kind"]; name: string; cmd: string; args: string[] }[] = [];
  for (const f of tree.files.filter((x) => /^tasks\/[A-Za-z0-9._-]+\/worker\.mjs$/.test(x.path))) {
    planned.push({ kind: "task_worker", name: f.path, cmd: process.execPath, args: [`${packRoot}/${f.path}`] });
  }
  const manifest = readFile(tree, "pack.json");
  let template: string | null = null;
  let dir = ".";
  try {
    const m = JSON.parse(new TextDecoder().decode(manifest?.content ?? new Uint8Array())) as { env?: { setup?: { template?: unknown; whenUnset?: unknown } } };
    const setup = m.env?.setup;
    if (typeof setup?.template === "string") {
      template = setup.template;
      const first = Array.isArray(setup.whenUnset) ? setup.whenUnset[0] : ".";
      if (typeof first === "string" && ENV_SETUP_DIR.test(first)) dir = first;
    }
  } catch {
    // An unreadable manifest has no env setup to run; the load step already reports it.
  }
  if (template !== null) planned.push({ kind: "env_setup", name: "pack.json", cmd: "bash", args: ["-c", template.replaceAll("{}", dir)] });

  const runs: Run[] = [];
  for (const p of planned) {
    if (!allowed) {
      runs.push({ kind: p.kind, name: p.name, status: "skipped", run_count: 0, exit_status: null, signal: null, timed_out: false, egress_count: 0 });
      continue;
    }
    const result = await exec({ cmd: p.cmd, args: p.args, cwd: repo, env: packEnv(home, runtime), timeoutMs: stepMs, user: runtime.user, recordEgress: true, onSpawn });
    const seen = parseEgress(result.egressLines, p.name);
    note(p.name, result.egressLines);
    runs.push({ kind: p.kind, name: p.name, status: "ran", run_count: 1, exit_status: result.exitCode, signal: result.signal, timed_out: result.timedOut, egress_count: seen.length });
  }
  return runs;
}

/** Egress lines are pack-reachable text: only well-formed records of a known kind survive, cleaned and bounded. */
export function parseEgress(lines: string[], run: string): SandboxBReport["egress"] {
  const out: SandboxBReport["egress"] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as { kind?: unknown; target?: unknown };
      if ((e.kind === "connect" || e.kind === "dns" || e.kind === "udp" || e.kind === "fetch") && typeof e.target === "string") out.push({ run, kind: e.kind, target: clean(e.target).slice(0, 200) });
    } catch {
      // A line the recorders did not write is not an egress record.
    }
  }
  return out;
}
