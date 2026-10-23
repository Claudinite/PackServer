import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicaliseArchive } from "@packserver/core/canonical";
import { acceptedCorpus, refusedCorpus, type CorpusCase } from "../fixtures/bombs/index.ts";
import { canonSamples } from "../fixtures/canon-samples/index.ts";
import { A_LIMITS } from "./a-limits.ts";
import { SandboxAReport } from "./a-report.ts";
import type { RunRequest } from "./a-run.ts";

/**
 * Runs the corpus through a built image on Docker with the production restrictions.
 * Usage: pnpm build, then node dist/a-corpus.mjs <image-ref> [image-digest] [canon-samples-dir]
 */
const image: string = process.argv[2] ?? "";
const digest = process.argv[3] ?? null;
if (!image) throw new Error("usage: a-corpus.ts <image-ref> [image-digest]");

const REQUEST: RunRequest = {
  pack: "@acme/corpus",
  newest_version: null,
  rules_version: "2026.10.1",
  lookups: { popular_packs: [], verified_scopes: [], proven_domain_labels: [], readable_packs: [] },
  previous_capabilities: null,
};

async function exists(path: string) {
  return access(path).then(() => true, () => false);
}

async function runCase(c: CorpusCase): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), `corpus-${c.name}-`));
  const problems: string[] = [];
  try {
    const upload = c.build();
    await writeFile(join(dir, "upload.tar.zst"), upload);
    await writeFile(join(dir, "request.json"), JSON.stringify(REQUEST));
    // The container is unprivileged, so the mounted input must be readable and the output writable by it.
    await chmod(dir, 0o777);
    const out = join(dir, "out");
    const mk = spawnSync("mkdir", ["-m", "777", out]);
    if (mk.status !== 0) throw new Error("cannot create the output directory");
    const started = Date.now();
    const run = spawnSync(
      "docker",
      [
        "run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp:size=16m", "--memory", "512m", "--memory-swap", "512m",
        "--cpus", "1", "--pids-limit", "64", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-v", `${dir}:/in:ro`, "-v", `${out}:/out`, ...(digest ? ["-e", `SANDBOX_IMAGE_DIGEST=${digest}`] : []), image,
      ],
      { timeout: A_LIMITS.runMs + 30_000, encoding: "utf8" },
    );
    const wall = Date.now() - started;
    if (run.status !== 0) return [`container exited ${run.status}: ${run.stderr.slice(0, 300)}`];
    if (wall > A_LIMITS.extractMs) problems.push(`took ${wall} ms, over the extraction cap`);
    const report = SandboxAReport.parse(JSON.parse(await readFile(join(out, "report.json"), "utf8")));
    if (digest && report.image_digest !== digest) problems.push("report does not carry the image digest");
    const canonicalPath = join(out, "canonical.tar.zst");
    if (c.expect === "ok") {
      if (report.outcome !== "ok") problems.push(`outcome ${report.outcome}, expected ok`);
      else {
        const host = await canonicaliseArchive(upload);
        const got = await readFile(canonicalPath);
        if (!Buffer.from(host.archive).equals(got)) problems.push("canonical bytes differ from the host's re-pack");
        if (report.tree_hash !== host.treeHash) problems.push("tree hash differs from the host's");
      }
    } else {
      if (report.outcome !== "refused" || report.refusal?.reason !== c.expect) problems.push(`got ${report.outcome}/${report.refusal?.reason ?? "-"}, expected ${c.expect}`);
      if (await exists(canonicalPath)) problems.push("a refused upload produced a canonical archive");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return problems;
}

let failed = 0;
const canon = await canonSamples(process.argv[4] ?? "sandbox/fixtures/canon-samples/packs");
const canonCases: CorpusCase[] = canon.map((s) => ({ name: `canon-${s.name}` as CorpusCase["name"], expect: "ok", build: () => s.archive }));
for (const c of [...refusedCorpus(), ...acceptedCorpus(), ...canonCases]) {
  const problems = await runCase(c);
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.name} (${c.expect})${problems.length ? `: ${problems.join("; ")}` : ""}`);
  if (problems.length) failed++;
}
process.exitCode = failed ? 1 : 0;
