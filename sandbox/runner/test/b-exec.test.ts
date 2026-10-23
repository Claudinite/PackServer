import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec, scrubbedEnv } from "../b-exec.ts";
import { fitToBCap, emptyBReport, SandboxBReport } from "../b-report.ts";
import { locate } from "../b-engine.ts";

const env = scrubbedEnv("/tmp");

/** A killed process that nothing has reaped yet still answers kill(pid, 0), so read its state. */
async function gone(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat === null || /^\d+ \(.*\) Z/.test(stat);
}
const sh = (script: string, timeoutMs = 5_000) => exec({ cmd: "bash", args: ["-c", script], cwd: tmpdir(), env, timeoutMs });

describe("exec", () => {
  it("passes exactly the scrubbed environment", async () => {
    process.env.B_TEST_SECRET = "leak";
    const r = await exec({ cmd: "bash", args: ["-c", "env | cut -d= -f1 | sort"], cwd: tmpdir(), env: scrubbedEnv("/tmp"), timeoutMs: 5_000 });
    delete process.env.B_TEST_SECRET;
    expect(r.output).not.toContain("B_TEST_SECRET");
    expect(r.output.split("\n")).toContain("GOPROXY");
  });

  it("keeps the head of the output and stays bounded", async () => {
    const r = await sh("echo head; head -c 5000000 /dev/zero | tr '\\0' x");
    expect(r.output.startsWith("head")).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(8 * 1024);
  });

  it("stops a command at its deadline and kills what it started", async () => {
    const dir = await mkdtemp(join(tmpdir(), "b-exec-"));
    const pidFile = join(dir, "pid");
    const r = await sh(`sleep 60 & echo $! > ${pidFile}; wait`, 500);
    expect(r.timedOut).toBe(true);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await gone(pid)).toBe(true);
  });

  it("kills a background process a finished command left behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "b-exec-"));
    const pidFile = join(dir, "pid");
    const r = await sh(`(sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}); exit 0`);
    expect(r.exitCode).toBe(0);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await gone(pid)).toBe(true);
  });

  it("reports an exit status and a signal as they are", async () => {
    expect((await sh("exit 3")).exitCode).toBe(3);
    expect((await sh("kill -9 $$")).signal).toBe("SIGKILL");
  });
});

describe("loader messages", () => {
  it("locates the first file-prefixed line relative to the pack", () => {
    expect(locate(".claudinite/shared/packs/acme/gcp/pack.json: invalid JSON", "@acme/gcp")).toEqual({ file: "pack.json", message: "invalid JSON" });
    expect(locate("checks/a.go:12:3: boom", "@acme/gcp")).toEqual({ file: "checks/a.go", message: "boom" });
  });

  it("keeps an unlocated message without a file, and nothing from empty output", () => {
    expect(locate("something went wrong", "@acme/gcp")).toEqual({ file: null, message: "something went wrong" });
    expect(locate("", "@acme/gcp")).toEqual({ file: null, message: null });
  });
});

describe("the report", () => {
  const base = { imageDigest: null, expectedTreeHash: "a".repeat(64), minEngineVersion: "1.0.0", oldestInMirror: "1.0.0" };

  it("refuses a field the schema does not name", () => {
    const report = { ...emptyBReport(base), verdict: "pass" };
    expect(SandboxBReport.safeParse(report).success).toBe(false);
  });

  it("refuses pack-sized free text", () => {
    const report = emptyBReport(base);
    report.engines = [{ role: "newest", version: "1.0.0", digest_verified: true, load: { status: "failed", exit_code: 1, file: null, message: "x".repeat(501) } }];
    expect(SandboxBReport.safeParse(report).success).toBe(false);
  });

  it("sheds the inventory before giving up, and gives up past that", () => {
    const report = emptyBReport(base);
    report.inventory = Array.from({ length: 1_000 }, (_, i) => ({ path: `skills/${"x".repeat(1_500)}/${i}`, kind: "other" as const, bytes: 1, tokens: null }));
    const fitted = fitToBCap(report);
    expect(fitted?.inventory.length).toBe(100);
    expect(fitted?.inventory_truncated).toBe(true);
    report.egress = Array.from({ length: 100 }, () => ({ run: null, kind: "connect" as const, target: "x".repeat(200) }));
    report.engines = Array.from({ length: 3_000 }, () => ({ role: "newest" as const, version: "1.0.0", digest_verified: true, load: { status: "failed" as const, exit_code: 1, file: null, message: "m".repeat(500) } }));
    expect(fitToBCap(report)).toBeNull();
  });
});
