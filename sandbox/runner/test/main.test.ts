import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicaliseArchive } from "@packserver/core/canonical";
import { fixtureArchive } from "@packserver/core/canonical/fixtures";
import { main } from "../a-main.ts";
import { SandboxAReport } from "../a-report.ts";
import { REQUEST, realWorker } from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "a-main-"));
  await writeFile(join(dir, "request.json"), JSON.stringify(REQUEST));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const options = async () => ({ inDir: dir, outDir: join(dir, "out"), imageDigest: "sha256:" + "b".repeat(64), workerUrl: await realWorker() });

describe("main", () => {
  it("writes the report and the canonical archive for an accepted upload", async () => {
    const upload = fixtureArchive("gcp");
    await writeFile(join(dir, "upload.tar.zst"), upload);
    const report = await main(await options());
    const written = SandboxAReport.parse(JSON.parse(await readFile(join(dir, "out", "report.json"), "utf8")));
    expect(written).toEqual(report);
    const canonical = await readFile(join(dir, "out", "canonical.tar.zst"));
    expect(Buffer.from((await canonicaliseArchive(upload)).archive).equals(canonical)).toBe(true);
  });

  it("writes a report and no archive for a refused upload", async () => {
    await writeFile(join(dir, "upload.tar.zst"), fixtureArchive("bomb-repetitive"));
    const report = await main(await options());
    expect(report.refusal?.reason).toBe("archive.bomb");
    await expect(stat(join(dir, "out", "canonical.tar.zst"))).rejects.toThrow();
  });

  it("refuses an over-long file from its length, writing nothing past the report (IT-VAL-022)", async () => {
    await writeFile(join(dir, "upload.tar.zst"), "");
    await truncate(join(dir, "upload.tar.zst"), 3 * 1024 * 1024 + 1);
    const report = await main(await options());
    expect(report.refusal).toEqual({ reason: "archive.bomb", code: "stored-length" });
    await expect(stat(join(dir, "out", "canonical.tar.zst"))).rejects.toThrow();
  });
});
