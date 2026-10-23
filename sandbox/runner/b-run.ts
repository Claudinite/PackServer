import { mkdir, mkdtemp, readFile as readDisk, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalise, extractArchive, readFile, sha256Hex, type Tree } from "@packserver/core/canonical";
import { compareThreePart, isThreePart } from "@packserver/core/validation";
import { compileChecks, parseDeclared } from "./b-checks.ts";
import { loadPack, makeFixtureRepo, unpackRelease, vendorDir, type Release } from "./b-engine.ts";
import { exec, scrubbedEnv } from "./b-exec.ts";
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
  /** The egress recorder every Node process of pack content loads; it sits beside the bundled runner. */
  preloadUrl?: string;
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

  const work = await mkdtemp(join(tmpdir(), "b-run-"));
  const home = join(work, "home");
  await mkdir(home, { recursive: true });
  try {
    const releases: { engine: EngineInput; release: Release; repo: string }[] = [];
    for (const [i, engine] of [...input.engines].sort((a, b) => (a.role === "newest" ? -1 : 1) - (b.role === "newest" ? -1 : 1)).entries()) {
      const tgz = join(work, `engine-${i}.tgz`);
      await writeFile(tgz, engine.tgz);
      const release = await unpackRelease(tgz, join(work, `engine-${i}`), home);
      if (!release) return { ...report, outcome: "error", error: "engine_unpack_failed" };
      releases.push({ engine, release, repo: join(work, `repo-${i}`) });
    }

    // From here on pack content is compiled and run.
    report = { ...report, pack_code_executed: true };
    publish();
    for (const { engine, release, repo } of releases) {
      await makeFixtureRepo(repo, input.pack, tree, home, release);
      const load = await loadPack(repo, release, input.pack, home, onSpawn);
      report = {
        ...report,
        engines: [...report.engines, { role: engine.role, version: engine.version, digest_verified: true, load: { status: load.status, exit_code: load.exitCode, file: load.file, message: load.message } }],
      };
      publish();
    }

    const primary = releases[0]!;
    const compile = await compileChecks(tree, primary.release, work, home, onSpawn);
    if (!compile) return { ...report, outcome: "error", error: "sdk_missing", timings_ms: { extract: extractMs, total: elapsed() } };
    report = { ...report, compile, declared: [...parseDeclared(tree), ...parseTasks(tree)] };
    publish();

    const loaded = report.engines[0]?.load.status === "loaded";
    const runs = await runContent(tree, input.pack, primary.repo, home, loaded, stepMs, onSpawn, work, hooks.preloadUrl ?? new URL("./b-preload.mjs", import.meta.url).href);
    report = { ...report, runs: runs.runs, egress: runs.egress.slice(0, B_LIMITS.egress), egress_total: runs.egress.length, egress_truncated: runs.egress.length > B_LIMITS.egress };
    report = { ...report, outcome: "ok", timings_ms: { extract: extractMs, total: elapsed() } };
    const fitted = fitToBCap(report);
    return SandboxBReport.parse(fitted ?? bErrorReport(base, "report_over_cap", { extract: extractMs, total: elapsed() }));
  } finally {
    await rm(work, { recursive: true, force: true });
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

async function runContent(tree: Tree, pack: string, repo: string, home: string, allowed: boolean, stepMs: number, onSpawn: (pgid: number) => void, work: string, preload: string) {
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
  const egress: SandboxBReport["egress"] = [];
  for (const [i, p] of planned.entries()) {
    if (!allowed) {
      runs.push({ kind: p.kind, name: p.name, status: "skipped", run_count: 0, exit_status: null, signal: null, timed_out: false, egress_count: 0 });
      continue;
    }
    const egressFile = join(work, `egress-${i}.jsonl`);
    const env = scrubbedEnv(home, { NODE_OPTIONS: `--import=${preload}`, B_EGRESS_FILE: egressFile });
    const result = await exec({ cmd: p.cmd, args: p.args, cwd: repo, env, timeoutMs: stepMs, onSpawn });
    const seen = await readEgress(egressFile, p.name);
    egress.push(...seen);
    runs.push({ kind: p.kind, name: p.name, status: "ran", run_count: 1, exit_status: result.exitCode, signal: result.signal, timed_out: result.timedOut, egress_count: seen.length });
  }
  return { runs, egress };
}

async function readEgress(file: string, run: string): Promise<SandboxBReport["egress"]> {
  const text = await readDisk(file, "utf8").then((t) => t.slice(0, 64 * 1024), () => "");
  const out: SandboxBReport["egress"] = [];
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line) as { kind?: unknown; target?: unknown };
      if ((e.kind === "connect" || e.kind === "dns" || e.kind === "udp" || e.kind === "fetch") && typeof e.target === "string") out.push({ run, kind: e.kind, target: clean(e.target).slice(0, 200) });
    } catch {
      // A line the preload did not write is not an egress record.
    }
  }
  return out;
}
