import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec, scrubbedEnv } from "../b-exec.ts";
import { lockOut, OutDirError } from "../b-isolation.ts";
import { clean, emptyBReport } from "../b-report.ts";
import { parseEgress } from "../b-run.ts";

const tmp = () => mkdtemp(join(tmpdir(), "b-iso-"));

describe("the output directory", () => {
  it("is refused when it holds anything", async () => {
    const out = await tmp();
    await writeFile(join(out, "report.json"), "planted");
    await expect(lockOut(out, undefined)).rejects.toBeInstanceOf(OutDirError);
    expect(await readFile(join(out, "report.json"), "utf8")).toBe("planted");
  });

  it("takes the report under a temporary name and leaves nothing else", async () => {
    const out = await tmp();
    const lock = await lockOut(out, undefined);
    await lock.publish("{}");
    expect(await readdir(out)).toEqual(["report.json"]);
    expect(await readFile(join(out, "report.json"), "utf8")).toBe("{}");
  });

  it("refuses to publish when something appeared in the directory during the run", async () => {
    const out = await tmp();
    const lock = await lockOut(out, undefined);
    await writeFile(join(out, "forged"), "x");
    await expect(lock.publish("{}")).rejects.toBeInstanceOf(OutDirError);
  });

  it("does not follow a link planted at the temporary name", async () => {
    const out = await tmp();
    const target = join(await tmp(), "victim");
    const lock = await lockOut(out, undefined);
    await symlink(target, join(out, `.report.${process.pid}.tmp`));
    await expect(lock.publish("{}")).rejects.toBeTruthy();
    await expect(lstat(target)).rejects.toThrow();
    await rm(out, { recursive: true });
    await mkdir(out);
  });
});

describe("commands", () => {
  it("a daemon that keeps the output pipe open cannot hold the step past its cap", async () => {
    const started = Date.now();
    const r = await exec({ cmd: "bash", args: ["-c", "setsid sleep 30 & sleep 30"], cwd: tmpdir(), env: scrubbedEnv("/tmp"), timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("text that came from pack content", () => {
  it("loses C1 controls, bidi marks and overrides, zero-width and separator characters", () => {
    expect(clean("a\u0085b‎c‮d⁦e​f﻿g h\u009fi")).toBe("abcdefghi");
    expect(clean("keeps\ttabs\nand lines")).toBe("keeps\ttabs\nand lines");
  });

  it("an egress line survives only as a known kind with a cleaned, bounded target", () => {
    const lines = ['{"kind":"connect","target":"1.1.1.1:80"}', '{"kind":"verdict","target":"x"}', "not json", `{"kind":"dns","target":"a\\u202eb${"x".repeat(500)}"}`];
    const seen = parseEgress(lines, "pack.json");
    expect(seen.map((e) => e.kind)).toEqual(["connect", "dns"]);
    expect(seen[1]!.target.startsWith("ab")).toBe(true);
    expect(seen[1]!.target.length).toBeLessThanOrEqual(200);
    expect(emptyBReport({ imageDigest: null, expectedTreeHash: "a".repeat(64), minEngineVersion: "1.0.0", oldestInMirror: "1.0.0" }).refusal).toBeNull();
  });
});
