import { describe, expect, it } from "vitest";
import { superviseB } from "../b-supervisor.ts";
import type { BRunInput } from "../b-run.ts";
import { stub } from "./helpers.ts";

const input: BRunInput = { pack: "@acme/gcp", canonical: new Uint8Array(), expectedTreeHash: "a".repeat(64), minEngineVersion: "1.61001.1", oldestInMirror: "1.61001.1", engines: [] };
const opts = { imageDigest: null, extractMs: 300, runMs: 2_500, heapMb: 64 };

describe("deadlines (IT-VAL-045)", () => {
  it("an extraction overrun is a final archive.unsafe refusal, as in sandbox A", async () => {
    const report = await superviseB(input, { ...opts, workerUrl: stub("hang-before-extract.mjs") });
    expect([report.outcome, report.error, report.refusal]).toEqual(["refused", null, { reason: "archive.unsafe", code: "extract-timeout" }]);
    expect(report.pack_code_executed).toBe(false);
  });

  it("a crash while the decoder holds the archive is a refusal too, a crash before it is an error", async () => {
    expect((await superviseB(input, { ...opts, workerUrl: stub("crash-during-extract.mjs") })).refusal).toEqual({ reason: "archive.unsafe", code: "extract-crash" });
    expect((await superviseB(input, { ...opts, workerUrl: stub("crash.mjs") })).outcome).toBe("error");
  });

  it("a worker that never starts is an infrastructure error", async () => {
    const report = await superviseB(input, { ...opts, workerUrl: stub("hang-at-boot.mjs") });
    expect(report.error).toBe("worker_start_timeout");
  });

  it("a run overrun is a timeout that keeps what the run had recorded", async () => {
    const report = await superviseB(input, { ...opts, extractMs: 2_000, workerUrl: stub("b-progress-then-hang.mjs") });
    expect([report.outcome, report.error]).toEqual(["timeout", null]);
    expect(report.engines.map((e) => e.load.status)).toEqual(["loaded"]);
    expect(report.pack_code_executed).toBe(true);
  });

  it("a run overrun with nothing recorded is still a timeout", async () => {
    const report = await superviseB(input, { ...opts, extractMs: 2_000, workerUrl: stub("hang-after-extract.mjs") });
    expect(report.outcome).toBe("timeout");
  });

  it("a crash and an off-schema report are infrastructure errors", async () => {
    expect((await superviseB(input, { ...opts, workerUrl: stub("crash.mjs") })).error).toBe("crashed");
    expect((await superviseB(input, { ...opts, workerUrl: stub("off-schema.mjs") })).error).toBe("report_invalid");
  });

  it("memory exhaustion while the decoder holds the archive is archive.bomb", async () => {
    const report = await superviseB(input, { ...opts, extractMs: 20_000, runMs: 20_000, workerUrl: stub("oom-before-extract.mjs") });
    expect(report.refusal).toEqual({ reason: "archive.bomb", code: "memory" });
  });
});
