import { PortError, SANDBOX_DIED, type Sandbox } from "@packserver/ports";
import { describe, expect, it, vi } from "vitest";
import type { ValidatorRuntime } from "../src/bindings";
import { runPipeline, type StepConfig, type StepRunner } from "../src/workflow/pipeline";
import * as steps from "../src/workflow/steps";

vi.mock("../src/workflow/steps", async (original) => {
  const real = await original<typeof import("../src/workflow/steps")>();
  const ok = async () => ({ stop: false, failed: false });
  return {
    ...real,
    start: vi.fn(async () => ({ rules: "2026.10.1", startAfter: "2000-01-01T00:00:00.000Z", finished: false })),
    integrity: vi.fn(async () => ({ stop: false })),
    refuse: vi.fn(async () => undefined),
    extraction: vi.fn(async () => ({ stop: false })),
    staticStep: vi.fn(ok),
    canonical: vi.fn(async () => ({ stop: false })),
    load: vi.fn(async () => ({ stop: false })),
    source: vi.fn(async () => ({ stop: false, sourceVerified: false })),
    proseScreen: vi.fn(async () => ({ stop: false, record: null })),
    thresholds: vi.fn(async () => ({ stop: false })),
    verdict: vi.fn(async () => ({ verdict: "pass", reportKey: "k", score: 100 })),
    fail: vi.fn(async () => undefined),
  };
});

vi.mock("../src/promote/promote", () => {
  const done = async () => undefined;
  return {
    prepare: vi.fn(async () => ({ promote: true, versionId: "v" })),
    writeObjects: vi.fn(done), commit: vi.fn(done), reindex: vi.fn(done), search: vi.fn(done), notify: vi.fn(done),
  };
});

const rt = { ports: { clock: { now: () => Date.now(), sync: async () => undefined } } } as unknown as ValidatorRuntime;

/** Runs each step once, records the policy it was given, and throws from the named steps. */
function runner(throwing: string[] = []) {
  const configs = new Map<string, StepConfig>();
  const calls: string[] = [];
  const step = {
    async do(name: string, a: StepConfig | (() => Promise<unknown>), b?: () => Promise<unknown>) {
      const fn = (typeof a === "function" ? a : b)!;
      if (typeof a !== "function") configs.set(name, a);
      calls.push(name);
      if (throwing.includes(name)) throw new Error("platform fault");
      return fn();
    },
    sleepUntil: async () => undefined,
  } as unknown as StepRunner;
  return { step, configs, calls };
}

describe("the pipeline's retry policy", () => {
  it("gives every step, the first and the last included, the same two retries", async () => {
    const { step, configs } = runner();
    await runPipeline(rt, step, { run_id: "r" }, { retryDelay: "30 seconds" });
    expect([...configs.keys()]).toEqual(expect.arrayContaining(["start", "began", "integrity", "extraction", "verdict", "human-review", "staged-approval"]));
    for (const [name, config] of configs) expect(config.retries, name).toEqual({ limit: 2, delay: "30 seconds", backoff: "exponential" });
  });

  it("refuses to run with a missing or malformed retry delay", async () => {
    await expect(runPipeline(rt, runner().step, { run_id: "r" }, { retryDelay: undefined })).rejects.toThrow("STEP_RETRY_DELAY");
    await expect(runPipeline(rt, runner().step, { run_id: "r" }, { retryDelay: "soon" })).rejects.toThrow("STEP_RETRY_DELAY");
  });
});

describe("a step that exhausts its retries", () => {
  it("ends the run with verdict error when the early `began` step throws, and runs nothing after it", async () => {
    vi.mocked(steps.fail).mockClear();
    const { step, calls } = runner(["began"]);
    await runPipeline(rt, step, { run_id: "r" }, { retryDelay: "10 milliseconds" });
    expect(steps.fail).toHaveBeenCalledWith(expect.objectContaining({ runId: "r" }), "infrastructure.error");
    expect(calls).toEqual(["start", "began", "finish-error"]);
  });

  it("does the same when the start step throws, using the pinned rules version", async () => {
    vi.mocked(steps.fail).mockClear();
    const { step, calls } = runner(["start"]);
    await runPipeline(rt, step, { run_id: "r" }, { retryDelay: "10 milliseconds" });
    expect(calls).toEqual(["start", "finish-error"]);
    expect(steps.fail).toHaveBeenCalledWith(expect.objectContaining({ rules: steps.pinnedRules() }), "infrastructure.error");
  });
});

describe("container A", () => {
  const request = { upload: new Uint8Array(), request: {} };
  const sandbox = (inspect: Sandbox["inspect"]): Sandbox => ({ inspect, run: async () => ({ report: {} }) });

  it("treats only a container that died decoding the upload as the archive's verdict", async () => {
    const died = sandbox(async () => {
      throw new PortError("crashed", `${SANDBOX_DIED}: the container exited`);
    });
    await expect(steps.inspectArchive(died, request)).resolves.toBe("died");
  });

  it("retries every other failure, the unwired port included", async () => {
    const unwired = sandbox(async () => {
      throw new PortError("unwired", "the sandbox has no production adapter");
    });
    await expect(steps.inspectArchive(unwired, request)).rejects.toThrow("no production adapter");
    const timeout = sandbox(async () => {
      throw new Error("network connection lost");
    });
    await expect(steps.inspectArchive(timeout, request)).rejects.toThrow("network connection lost");
  });

  it("returns the report of a container that answered, refusals included", async () => {
    const answer = { report: { outcome: "refused" }, canonical: null };
    await expect(steps.inspectArchive(sandbox(async () => answer), request)).resolves.toBe(answer);
  });
});
