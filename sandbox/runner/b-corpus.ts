import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalOf, LOAD_RUN_CASES, PACK, PINNED, writeMirror, type LoadRunCase } from "../fixtures/load-run/index.ts";
import { B_LIMITS } from "./b-limits.ts";
import { dirMirror, prepareInput } from "./b-prepare.ts";
import { SandboxBReport } from "./b-report.ts";

/**
 * Runs the load-and-run cases through a built image on Docker with the production restrictions.
 * The cn releases are fakes served from a throwaway mirror laid out like the real one.
 * Usage: pnpm build, then from the repository root: node dist/b-corpus.mjs <image-ref> [image-digest] [fake-cn-path]
 */
const image: string = process.argv[2] ?? "";
const digest = process.argv[3] ?? null;
if (!image) throw new Error("usage: b-corpus.ts <image-ref> [image-digest]");

const root = await mkdtemp(join(tmpdir(), "b-corpus-"));
const mirror = join(root, "mirror");
const { sha256 } = writeMirror(mirror, undefined, process.argv[4] ?? "sandbox/fixtures/load-run/fake-cn.mjs");

interface Prepared {
  name: string;
  files: Record<string, string>;
  minEngineVersion: string;
  expectedTreeHash?: string;
  hostEnv?: Record<string, string>;
  problems: LoadRunCase["problems"];
}

async function runInContainer(c: Prepared): Promise<{ problems: string[]; report?: SandboxBReport; out?: string }> {
  const dir = await mkdtemp(join(root, `${c.name}-`));
  const { archive, treeHash } = canonicalOf(c.files);
  await prepareInput({ dir, mirror: dirMirror(mirror), pack: PACK, canonical: archive, expectedTreeHash: c.expectedTreeHash ?? treeHash, minEngineVersion: c.minEngineVersion, pinned: { version: PINNED, sha256: sha256[PINNED]! } });
  // The container is unprivileged, so the mounted input must be readable and the output writable by it.
  await chmod(dir, 0o777);
  const out = join(dir, "out");
  await mkdir(out, { mode: 0o777 });
  await chmod(out, 0o777);
  const env = Object.entries({ CORPUS_SECRET: "leak", CF_API_TOKEN: "leak", ...c.hostEnv }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const started = Date.now();
  const run = spawnSync(
    "docker",
    [
      "run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,exec,size=256m", "--memory", "1g", "--memory-swap", "1g",
      "--cpus", "1", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-v", `${dir}:/in:ro`, "-v", `${out}:/out`, ...env, ...(digest ? ["-e", `SANDBOX_IMAGE_DIGEST=${digest}`] : []), image,
    ],
    { timeout: B_LIMITS.runMs + 30_000, encoding: "utf8" },
  );
  if (run.status !== 0) return { problems: [`container exited ${run.status}: ${run.stderr.slice(0, 300)}`] };
  const wall = Date.now() - started;
  const problems: string[] = [];
  if (wall > B_LIMITS.runMs) problems.push(`took ${wall} ms, over the run cap`);
  const report = SandboxBReport.parse(JSON.parse(await readFile(join(out, "report.json"), "utf8")));
  if (digest && report.image_digest !== digest) problems.push("report does not carry the image digest");
  const files = await readdir(out);
  if (files.join() !== "report.json") problems.push(`output holds ${files.join()}`);
  return { problems, report, out };
}

const cases: Prepared[] = [...LOAD_RUN_CASES];
const gcp = LOAD_RUN_CASES[0]!;
cases.push({
  name: "tree-hash-mismatch",
  files: gcp.files,
  minEngineVersion: gcp.minEngineVersion,
  expectedTreeHash: "0".repeat(64),
  problems: (r) => (r.error === "tree_hash_mismatch" && !r.pack_code_executed && r.runs.length === 0 ? [] : [`got ${r.outcome}/${r.error}, ran=${r.pack_code_executed}`]),
});
// A fresh container leaves nothing behind: the second run exits 9 if the first one's marker is still there.
const marker = { ...gcp.files, "tasks/nightly/worker.mjs": "import { existsSync, writeFileSync } from 'node:fs';\nconst seen = existsSync('/tmp/marker');\nwriteFileSync('/tmp/marker', 'x');\nprocess.exit(seen ? 9 : 0);\n" };
for (const name of ["marker-first", "marker-second"]) {
  cases.push({ name, files: marker, minEngineVersion: gcp.minEngineVersion, problems: (r) => (r.runs.find((x) => x.kind === "task_worker")?.exit_status === 0 ? [] : ["a marker survived into the next run"]) });
}

// A worker that leaves a process of its own session behind, rewriting the report file until the container ends.
const daemon = { ...gcp.files, "tasks/nightly/worker.mjs": "import { spawn } from 'node:child_process';\nspawn('setsid', ['sh', '-c', 'while true; do echo forged > /out/report.json; sleep 0.02; done'], { detached: true, stdio: 'ignore' }).unref();\n" };
cases.push({ name: "daemon-forges-report", files: daemon, minEngineVersion: gcp.minEngineVersion, problems: (r) => (r.outcome === "ok" && r.runs.some((x) => x.kind === "task_worker" && x.exit_status === 0) ? [] : ["the report is not the runner's"]) });

let failed = 0;
try {
  for (const c of cases) {
    const result = await runInContainer(c).catch((e: unknown) => ({ problems: [`harness error: ${String(e).slice(0, 200)}`] }) as { problems: string[]; report?: SandboxBReport });
    const problems = [...result.problems, ...(result.report ? c.problems(result.report) : [])];
    console.log(`${problems.length ? "FAIL" : "ok  "} ${c.name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
    if (problems.length) failed++;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
