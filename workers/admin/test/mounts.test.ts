import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditBucket, SqliteD1 } from "@packserver/core/audit/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { CRON_DAILY, CRON_HOURLY, CRON_JOBS, runCron } from "../src/crons";
import { auditHead } from "../src/crons/audit-head";
import { auditVerify } from "../src/crons/audit-verify";
import { trending } from "../src/crons/trending";
import { domainRecheck } from "../src/crons/domain-recheck";
import { githubProofLapse } from "../src/crons/github-proof-lapse";
import type { AdminRuntime } from "../src/bindings";

const fakes = createFakePorts({ worker: "admin" });
fakes.d1.on(/delete from recent_activity/, () => ({}));
fakes.d1.on(/from github_org_proofs/, () => ({ rows: [] }));
const runtime = {
  worker: "admin",
  environment: "test",
  version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
  missingBindings: [],
  missingSecrets: [],
  ports: { ...fakes, d1: new SqliteD1(), auditBucket: new MemoryAuditBucket(), r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! } },
  services: {},
  config: { siteOrigin: "https://registry.test" },
} satisfies AdminRuntime;

afterEach(() => vi.restoreAllMocks());

describe("admin mounts", () => {
  it.each(["access", "queue", "applications", "reports", "moderation", "internal"])("%s exports a router", async (m) => {
    const mod = (await import(/* @vite-ignore */ `../src/${m}/index.ts`)) as { routes?: unknown };
    expect(mod.routes).toBeInstanceOf(Hono);
  });
});

describe("admin crons", () => {
  const wrangler = JSON.parse(readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8")) as {
    env: Record<string, { triggers?: { crons: string[] } }>;
  };

  it.each(["staging", "production"])("env.%s fires exactly the triggers that have jobs", (env) => {
    expect(wrangler.env[env]?.triggers?.crons.sort()).toEqual([CRON_HOURLY, CRON_DAILY].sort());
    expect(Object.keys(CRON_JOBS).sort()).toEqual([CRON_HOURLY, CRON_DAILY].sort());
  });

  it("runs every stub job of a trigger and says so; the audit jobs have their own test", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stubs = CRON_JOBS[CRON_DAILY]!.filter((job) => ![auditHead, auditVerify, domainRecheck, githubProofLapse, trending].includes(job));
    await Promise.all(stubs.map((job) => job(runtime)));
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)).entry).sort()).toEqual(["cron.prune"]);
  });

  it("refuses a trigger it has no jobs for", async () => {
    await expect(runCron("* * * * *", runtime)).rejects.toThrow("no jobs");
  });

  it("lets one failing job fail the run without skipping the others", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    log.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(runCron(CRON_HOURLY, runtime)).rejects.toThrow("1 of 3 jobs");
    expect(log).toHaveBeenCalledTimes(3);
  });
});
