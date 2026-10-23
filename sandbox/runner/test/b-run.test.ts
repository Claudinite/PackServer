import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalOf, LOAD_RUN_CASES, PACK, PINNED, writeMirror } from "../../fixtures/load-run/index.ts";
import { bMain } from "../b-main.ts";
import { dirMirror, prepareInput } from "../b-prepare.ts";
import { SandboxBReport } from "../b-report.ts";
import { realB } from "./b-helpers.ts";

let root: string;
let mirror: string;
let sha256: Record<string, string>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "b-run-test-"));
  mirror = join(root, "mirror");
  sha256 = writeMirror(mirror).sha256;
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function run(files: Record<string, string>, minEngineVersion: string, over: { expectedTreeHash?: string; hostEnv?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(root, "case-"));
  const { archive, treeHash } = canonicalOf(files);
  await prepareInput({ dir, mirror: dirMirror(mirror), pack: PACK, canonical: archive, expectedTreeHash: over.expectedTreeHash ?? treeHash, minEngineVersion, newest: PINNED, digests: sha256 });
  const { workerUrl, runtime } = await realB();
  const saved = Object.fromEntries(Object.keys(over.hostEnv ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, over.hostEnv);
  try {
    const report = await bMain({ inDir: dir, outDir: join(dir, "out"), imageDigest: "sha256:" + "c".repeat(64), workerUrl, runtime, stepMs: 1_000 });
    return { report, dir };
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("load and run (IT-VAL-010, 011, 029, 032, 045)", () => {
  it.each(LOAD_RUN_CASES.filter((c) => !c.container).map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const { report, dir } = await run(c.files, c.minEngineVersion, { hostEnv: c.hostEnv });
    expect(c.problems(report)).toEqual([]);
    expect(SandboxBReport.parse(JSON.parse(await readFile(join(dir, "out", "report.json"), "utf8")))).toEqual(report);
    expect(report.image_digest).toBe("sha256:" + "c".repeat(64));
    // Nothing B produces is served: the report is all there is.
    expect(await readdir(join(dir, "out"))).toEqual(["report.json"]);
  }, 60_000);
});

describe("a tree-hash mismatch refuses the load step (IT-VAL-051)", () => {
  it("runs no pack content at all", async () => {
    const marker = join(root, "marker-should-not-exist");
    const files = { ...LOAD_RUN_CASES[0]!.files, "tasks/nightly/worker.mjs": `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n` };
    const { report } = await run(files, "1.61001.1", { expectedTreeHash: canonicalOf(LOAD_RUN_CASES[0]!.files).treeHash });
    expect(report.outcome).toBe("error");
    expect(report.error).toBe("tree_hash_mismatch");
    expect(report.tree.matches).toBe(false);
    expect(report.pack_code_executed).toBe(false);
    expect([report.engines, report.compile, report.runs, report.egress]).toEqual([[], [], [], []]);
    await expect(stat(marker)).rejects.toThrow();
  }, 60_000);

  it("contrast: the same worker runs when the hash matches", async () => {
    const marker = join(root, "marker-written");
    const files = { ...LOAD_RUN_CASES[0]!.files, "tasks/nightly/worker.mjs": `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n` };
    await run(files, "1.61001.1");
    expect(await readFile(marker, "utf8")).toBe("ran");
  }, 60_000);

  it("refuses an engine that does not hash to its pin, before running anything", async () => {
    const dir = await mkdtemp(join(root, "case-"));
    const { archive, treeHash } = canonicalOf(LOAD_RUN_CASES[0]!.files);
    const request = await prepareInput({ dir, mirror: dirMirror(mirror), pack: PACK, canonical: archive, expectedTreeHash: treeHash, minEngineVersion: "1.61001.1", newest: PINNED, digests: sha256 });
    await writeFile(join(dir, "cn", request.engines[0]!.file), "not the release");
    const { workerUrl, runtime } = await realB();
    const report = await bMain({ inDir: dir, outDir: join(dir, "out"), imageDigest: null, workerUrl, runtime });
    expect(report.error).toBe("engine_digest_mismatch");
    expect(report.pack_code_executed).toBe(false);
  }, 60_000);
});

describe("input", () => {
  it("a missing canonical archive is an input error", async () => {
    const dir = await mkdtemp(join(root, "case-"));
    const { archive, treeHash } = canonicalOf(LOAD_RUN_CASES[0]!.files);
    await prepareInput({ dir, mirror: dirMirror(mirror), pack: PACK, canonical: archive, expectedTreeHash: treeHash, minEngineVersion: "1.61001.1", newest: PINNED, digests: sha256 });
    await rm(join(dir, "canonical.tar.zst"));
    const { workerUrl } = await realB();
    const report = await bMain({ inDir: dir, outDir: join(dir, "out"), imageDigest: null, workerUrl });
    expect(report.error).toBe("input_invalid");
  });

  it("a minimum between two releases asks for the older release that satisfies it, or only the newest when none is lower", async () => {
    const dir = await mkdtemp(join(root, "case-"));
    const { archive, treeHash } = canonicalOf(LOAD_RUN_CASES[0]!.files);
    const request = await prepareInput({ dir, mirror: dirMirror(mirror), pack: PACK, canonical: archive, expectedTreeHash: treeHash, minEngineVersion: "1.61002.0", newest: PINNED, digests: sha256 });
    expect(request.engines.map((e) => [e.role, e.version])).toEqual([["newest", "1.61004.1"]]);
  });
});
