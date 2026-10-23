import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree, canonicalArchive, canonicalise } from "../../../packages/core/canonical/index.ts";
import type { SandboxBReport } from "../../runner/b-report.ts";

/** The mirror the cases run against: two releases, so a pack can be loaded on its lowest allowed engine. */
export const MIRROR_VERSIONS = ["1.61001.1", "1.61004.1"] as const;
export const PINNED = "1.61004.1";
export const PACK = "@acme/gcp";

const CHECKSDK_GO = `package checksdk

type Check struct {
	ID     string
	Tags   []string
	OnFail string
	Doc    string
	Why    string
	Run    func() error
}

func Register(c Check) {}
`;

function tgz(files: Record<string, string | Buffer>, executable: string[]): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "fake-release-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
      if (executable.includes(path)) chmodSync(join(dir, path), 0o755);
    }
    const out = join(dir, "..", `${dir.split("/").pop()}.tgz`);
    const run = spawnSync("tar", ["-czf", out, "-C", dir, "."]);
    if (run.status !== 0) throw new Error("tar failed");
    const bytes = new Uint8Array(readFileSync(out));
    rmSync(out);
    return bytes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A cn release tarball as the runner expects one: the binary, the check SDK, and a version file the fake reads. */
export function fakeRelease(version: string, cnPath: string = fileURLToPath(new URL("./fake-cn.mjs", import.meta.url))): { tgz: Uint8Array; sha256: string } {
  const bytes = tgz(
    {
      cn: readFileSync(cnPath),
      VERSION: version,
      "checksdk/go.mod": "module claudinite.com/checksdk\n\ngo 1.24\n",
      "checksdk/checksdk.go": CHECKSDK_GO,
    },
    ["cn"],
  );
  return { tgz: bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Writes `cn-releases/` the way the engine's release workflow lays it out. */
export function writeMirror(root: string, versions: readonly string[] = MIRROR_VERSIONS, cnPath?: string): { sha256: Record<string, string> } {
  mkdirSync(join(root, "cn-releases"), { recursive: true });
  const sha256: Record<string, string> = {};
  for (const v of versions) {
    const r = fakeRelease(v, cnPath);
    writeFileSync(join(root, "cn-releases", `${v}.tgz`), r.tgz);
    writeFileSync(join(root, "cn-releases", `${v}.sha256`), `${r.sha256}  ${v}.tgz\n`);
    sha256[v] = r.sha256;
  }
  writeFileSync(join(root, "cn-releases", "manifest.json"), JSON.stringify({ oldest: versions[0], versions: sha256 }));
  return { sha256 };
}

const GOOD_CHECK = `package checks

import "claudinite.com/checksdk"

func init() {
	checksdk.Register(checksdk.Check{ID: "acme/ok", OnFail: "advise", Run: func() error { return nil }})
}
`;

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: "1.0.0", minEngineVersion: "1.61001.1", env: { setup: { forEach: "dirs", whenUnset: ["."], template: "exit 0" } }, ...extra });

const BASE: Record<string, string> = {
  "pack.json": manifest(),
  "RULES.md": "# Rules\n\nBe kind.\n",
  "skills/greet/SKILL.md": "# Greet\n\nSay hello.\n",
  "checks/ok.go": GOOD_CHECK,
  "declared-checks.json": JSON.stringify([{ id: "acme/no-todo", on_fail: "advise" }]),
  "tasks/nightly/task.json": JSON.stringify({ id: "nightly", code_worker_mjs: "worker.mjs" }),
  "tasks/nightly/worker.mjs": "console.log('worked');\n",
};

export interface LoadRunCase {
  name: string;
  files: Record<string, string>;
  minEngineVersion: string;
  /** Environment the container is given and must not pass on. */
  hostEnv?: Record<string, string>;
  /** Needs the pack identity to be a different user from the runner, which only the container provides. */
  container?: true;
  /** Problems found in the report; empty when it is what the case should produce. */
  problems: (report: SandboxBReport) => string[];
}

const fail = (cond: boolean, what: string) => (cond ? [] : [what]);
const loadedOn = (r: SandboxBReport, n: number) => fail(r.engines.length === n && r.engines.every((e) => e.load.status === "loaded"), `expected ${n} engine(s) loaded, got ${JSON.stringify(r.engines.map((e) => [e.role, e.load.status, e.load.message]))}`);
const clean = (r: SandboxBReport) => [
  ...fail(r.outcome === "ok", `outcome ${r.outcome} ${r.error ?? ""}`),
  ...fail(r.pack_code_executed, "pack content did not run"),
  ...fail(r.egress_total === 0, "unexpected egress"),
];

export const LOAD_RUN_CASES: LoadRunCase[] = [
  {
    name: "gcp",
    files: BASE,
    minEngineVersion: "1.61001.1",
    problems: (r) => [
      ...clean(r),
      ...loadedOn(r, 2),
      ...fail(r.compile.length === 1 && r.compile[0]!.status === "compiled", "the coded check did not compile"),
      ...fail(r.declared.length === 2 && r.declared.every((d) => d.status === "parsed"), "declared checks or the task did not parse"),
      ...fail(r.runs.length === 2 && r.runs.every((x) => x.status === "ran" && x.exit_status === 0 && x.run_count === 1), `runs ${JSON.stringify(r.runs)}`),
      ...fail(r.inventory_total === 7 && (r.token_counts?.total ?? 0) > 0, "inventory or token counts missing"),
    ],
  },
  {
    name: "check-does-not-compile",
    files: { ...BASE, "checks/ok.go": GOOD_CHECK.replace("return nil", "return undefinedName") },
    minEngineVersion: "1.61001.1",
    problems: (r) => [...fail(r.compile[0]?.status === "failed" && r.compile[0].file === "checks/ok.go" && /undefined/.test(r.compile[0].message ?? ""), `compile ${JSON.stringify(r.compile)}`)],
  },
  {
    name: "declared-check-does-not-parse",
    files: { ...BASE, "declared-checks.json": "[{ \"id\": " },
    minEngineVersion: "1.61001.1",
    problems: (r) => [...fail(r.declared.some((d) => d.file === "declared-checks.json" && d.status === "failed"), `declared ${JSON.stringify(r.declared)}`)],
  },
  {
    name: "with-env-setup",
    files: { ...BASE, "pack.json": manifest({ env: { setup: { forEach: "dirs", whenUnset: ["."], template: "exit 3" } } }) },
    minEngineVersion: "1.61001.1",
    problems: (r) => {
      const env = r.runs.find((x) => x.kind === "env_setup");
      return [...fail(env?.exit_status === 3 && env.run_count === 1, `env setup ${JSON.stringify(env)}`), ...fail(r.outcome === "ok", "outcome")];
    },
  },
  {
    name: "with-network-call",
    files: {
      ...BASE,
      "tasks/nightly/worker.mjs": [
        "import net from 'node:net';",
        "import http from 'node:http';",
        "net.connect(80, '203.0.113.9').on('error', () => {});",
        "http.get('http://example.invalid/x').on('error', () => {});",
        "try { await fetch('https://example.invalid/y'); } catch {}",
        "await new Promise((r) => setTimeout(r, 200));",
      ].join("\n"),
    },
    minEngineVersion: "1.61001.1",
    problems: (r) => [
      ...fail(r.egress_total >= 3, `egress ${JSON.stringify(r.egress)}`),
      ...fail(r.egress.some((e) => e.kind === "connect" && e.target === "203.0.113.9:80"), "the raw connect was not recorded"),
      ...fail(r.egress.some((e) => e.kind === "fetch"), "the fetch was not recorded"),
      ...fail(r.runs.find((x) => x.kind === "task_worker")?.egress_count === r.egress_total, "egress was not attributed to the worker"),
    ],
  },
  {
    name: "reads-the-environment",
    files: {
      ...BASE,
      "tasks/nightly/worker.mjs": "const leaked = Object.keys(process.env).filter((k) => /SECRET|TOKEN|KEY|CF_|AWS/.test(k));\nprocess.exit(leaked.length ? 7 : 0);\n",
    },
    minEngineVersion: "1.61001.1",
    hostEnv: { CORPUS_SECRET: "leak", CF_API_TOKEN: "leak", AWS_KEY: "leak" },
    problems: (r) => [...fail(r.runs.find((x) => x.kind === "task_worker")?.exit_status === 0, "the worker saw a host variable")],
  },
  {
    name: "env-setup-dev-tcp",
    files: { ...BASE, "pack.json": manifest({ env: { setup: { forEach: "dirs", whenUnset: ["."], template: "echo > /dev/tcp/1.1.1.1/80; true" } } }) },
    minEngineVersion: "1.61001.1",
    problems: (r) => [
      ...fail(r.egress.some((e) => e.run === "pack.json" && e.target.includes("1.1.1.1")), `egress ${JSON.stringify(r.egress)}`),
      ...fail(r.runs.find((x) => x.kind === "env_setup")?.egress_count !== 0, "the env setup has no egress count"),
    ],
  },
  {
    name: "env-setup-name-lookup",
    files: { ...BASE, "pack.json": manifest({ env: { setup: { forEach: "dirs", whenUnset: ["."], template: "getent hosts example.invalid; true" } } }) },
    minEngineVersion: "1.61001.1",
    problems: (r) => [...fail(r.egress.some((e) => e.run === "pack.json" && e.kind === "dns" && e.target === "example.invalid"), `egress ${JSON.stringify(r.egress)}`)],
  },
  {
    name: "fails-to-load",
    files: { ...BASE, "pack.json": "{" },
    minEngineVersion: "1.61001.1",
    problems: (r) => [
      ...fail(r.engines.length > 0 && r.engines.every((e) => e.load.status === "failed" && e.load.file === "pack.json"), `engines ${JSON.stringify(r.engines)}`),
      ...fail(r.runs.every((x) => x.status === "skipped"), "pack scripts ran although the pack did not load"),
    ],
  },
  {
    name: "needs-newer-engine",
    files: { ...BASE, "pack.json": manifest({ usesFeature: "scoped-ids" }) },
    minEngineVersion: "1.61001.1",
    problems: (r) => {
      const by = Object.fromEntries(r.engines.map((e) => [e.role, e.load]));
      return [...fail(by.newest?.status === "loaded" && by.lowest?.status === "failed" && by.lowest.file === "pack.json", `engines ${JSON.stringify(r.engines)}`)];
    },
  },
  {
    name: "min-engine-below-the-mirror",
    files: BASE,
    minEngineVersion: "1.60000.0",
    problems: (r) => [
      ...fail(!r.min_engine.supported && r.outcome === "ok", "not reported as unsupported"),
      ...fail(!r.pack_code_executed && r.engines.length === 0, "something ran"),
    ],
  },
  {
    name: "floods-output",
    files: {
      ...BASE,
      "tasks/nightly/worker.mjs": "const line = JSON.stringify({ outcome: 'ok', tree: { matches: true }, pack_code_executed: false }) + '\\n';\nconst end = Date.now() + 1500;\nwhile (Date.now() < end) process.stdout.write(line.repeat(2000));\n",
    },
    minEngineVersion: "1.61001.1",
    problems: (r) => [...fail(r.outcome === "ok" && r.pack_code_executed, "output changed the verdict fields"), ...fail(Buffer.byteLength(JSON.stringify(r)) < 256 * 1024, "report over the cap")],
  },
  {
    name: "never-ends",
    files: { ...BASE, "tasks/nightly/worker.mjs": "setInterval(() => {}, 1000);\n" },
    minEngineVersion: "1.61001.1",
    problems: (r) => [...fail(r.runs.find((x) => x.kind === "task_worker")?.timed_out === true, "the worker was not stopped at its step cap"), ...fail(r.outcome === "ok", "outcome")],
  },
];

const worker = (source: string): LoadRunCase["files"] => ({ ...BASE, "tasks/nightly/worker.mjs": source });

// Cases that need the pack identity to be another user than the runner.
LOAD_RUN_CASES.push(
  {
    name: "forges-the-report",
    container: true,
    files: worker(
      [
        "import fs from 'node:fs';",
        "let wrote = 0;",
        "for (const f of ['/out/report.json', '/out/evil']) {",
        "  try { fs.writeFileSync(f, '{\"forged\":true}'); wrote++; try { fs.chmodSync(f, 0o444); } catch {} } catch {}",
        "}",
        "try { fs.symlinkSync('/etc/passwd', '/out/link'); wrote++; } catch {}",
        "try { fs.mkdirSync('/out/dir'); wrote++; } catch {}",
        "process.exit(wrote ? 8 : 0);",
      ].join("\n"),
    ),
    minEngineVersion: "1.61001.1",
    problems: (r) => [...fail(r.runs.find((x) => x.kind === "task_worker")?.exit_status === 0, "the worker could write into the output directory"), ...fail(r.outcome === "ok", "outcome")],
  },
  {
    name: "reads-the-runner-environment",
    container: true,
    files: worker("import fs from 'node:fs';\nlet leaked = 0;\nfor (const p of [process.ppid, 1]) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').includes('CORPUS_SECRET')) leaked++; } catch {} }\nprocess.exit(leaked ? 7 : 0);\n"),
    minEngineVersion: "1.61001.1",
    hostEnv: { CORPUS_SECRET: "leak" },
    problems: (r) => [...fail(r.runs.find((x) => x.kind === "task_worker")?.exit_status === 0, "the worker read the runner's environment")],
  },
  {
    name: "runs-unprivileged-and-cannot-touch-the-engine",
    container: true,
    files: worker(
      [
        "import fs from 'node:fs';",
        "let bad = process.getuid() === 0 || process.getgid() === 0 || process.getgroups().includes(0) ? 1 : 0;",
        "for (const w of fs.readdirSync('/tmp').filter((n) => n.startsWith('b-run-'))) {",
        "  for (const e of ['engine-0', 'engine-1']) {",
        "    try { fs.appendFileSync(`/tmp/${w}/${e}/cn`, '#'); bad += 10; } catch {}",
        "  }",
        "  try { fs.writeFileSync(`/tmp/${w}/go.work`, 'x'); bad += 100; } catch {}",
        "}",
        "process.exit(bad);",
      ].join("\n"),
    ),
    minEngineVersion: "1.61001.1",
    problems: (r) => [...fail(r.runs.find((x) => x.kind === "task_worker")?.exit_status === 0, `the worker ran as root or altered the runner's files ${JSON.stringify(r.runs)}`)],
  },
);

export function treeOf(files: Record<string, string>) {
  return buildTree(Object.entries(files).map(([path, c]) => ({ path, executable: false, content: new TextEncoder().encode(c) })));
}

/** The canonical archive of a case and the tree hash sandbox A would have committed for it. */
export function canonicalOf(files: Record<string, string>) {
  const tree = treeOf(files);
  return { archive: canonicalArchive(tree), treeHash: canonicalise(tree).treeHash };
}

