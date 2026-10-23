import { describe, expect, it } from "vitest";
import { fixtureArchive } from "@packserver/core/canonical/fixtures";
import { supervise } from "../a-supervisor.ts";
import { REQUEST, realWorker, stub } from "./helpers.ts";

const upload = fixtureArchive("gcp");
const opts = { imageDigest: null, extractMs: 300, runMs: 600, heapMb: 64 };

describe("deadlines (IT-VAL-045)", () => {
  it("runs the real worker end to end", async () => {
    const { report, canonical } = await supervise(upload, REQUEST, { workerUrl: await realWorker(), imageDigest: null });
    expect(report.outcome).toBe("ok");
    expect(canonical).not.toBeNull();
    expect(report.inspectors.map((i) => i.status)).toEqual(["skipped"]);
  });

  it("an extraction overrun is a final archive.unsafe verdict", async () => {
    const { report, canonical } = await supervise(upload, REQUEST, { ...opts, workerUrl: stub("hang-before-extract.mjs") });
    expect(report.outcome).toBe("refused");
    expect(report.refusal).toEqual({ reason: "archive.unsafe", code: "extract-timeout" });
    expect(report.findings.map((f) => f.rule)).toEqual(["archive.unsafe"]);
    expect(canonical).toBeNull();
  });

  it("stops a worker that never yields", async () => {
    const started = Date.now();
    const { report } = await supervise(upload, REQUEST, { ...opts, workerUrl: stub("spin-before-extract.mjs") });
    expect(report.refusal?.code).toBe("extract-timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a run overrun after extraction is a timeout, not a verdict on the archive", async () => {
    const { report } = await supervise(upload, REQUEST, { ...opts, extractMs: 2_000, runMs: 2_500, workerUrl: stub("hang-after-extract.mjs") });
    expect(report.outcome).toBe("timeout");
    expect(report.refusal).toBeNull();
    expect(report.findings).toEqual([]);
  });

  it("memory exhaustion during extraction is archive.bomb", async () => {
    const { report } = await supervise(upload, REQUEST, { ...opts, extractMs: 20_000, runMs: 20_000, workerUrl: stub("oom-before-extract.mjs") });
    expect(report.refusal).toEqual({ reason: "archive.bomb", code: "memory" });
  });
});

describe("untrusted worker output", () => {
  // Cold worker start-up must not be able to reach the deadline.
  const generous = { ...opts, extractMs: 30_000, runMs: 30_000 };

  it("a crash during extraction is a final archive.unsafe, not a retryable error", async () => {
    const { report, canonical } = await supervise(upload, REQUEST, { ...generous, workerUrl: stub("crash.mjs") });
    expect(report.outcome).toBe("refused");
    expect(report.refusal).toEqual({ reason: "archive.unsafe", code: "extract-crash" });
    expect(canonical).toBeNull();
  });

  it("a crash after extraction finished is an infrastructure error", async () => {
    const { report } = await supervise(upload, REQUEST, { ...generous, workerUrl: stub("crash-after-extract.mjs") });
    expect(report.outcome).toBe("error");
    expect(report.error).toBe("worker crashed");
  });

  it("an off-schema report is an infrastructure error", async () => {
    const { report, canonical } = await supervise(upload, REQUEST, { ...generous, workerUrl: stub("off-schema.mjs") });
    expect(report.outcome).toBe("error");
    expect(canonical).toBeNull();
  });
});
