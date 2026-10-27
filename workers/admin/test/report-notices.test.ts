import { SqliteD1, MemoryAuditBucket } from "@packserver/core/audit/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { describe, expect, it, vi } from "vitest";
import type { AdminRuntime } from "../src/bindings";
import { CRON_JOBS, CRON_REPORTS } from "../src/crons";
import { reportNotices } from "../src/crons/report-notices";

function runtimeWith(config: AdminRuntime["config"]): AdminRuntime {
  const fakes = createFakePorts({ worker: "admin" });
  return {
    worker: "admin",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...fakes, d1: new SqliteD1(), auditBucket: new MemoryAuditBucket(), r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! } },
    services: {},
    config,
  };
}

describe("report-notices cron", () => {
  it("runs on its own trigger and says what it did", async () => {
    expect(CRON_JOBS[CRON_REPORTS]).toContain(reportNotices);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await reportNotices(runtimeWith({ siteOrigin: "https://registry.test", securityAddress: "security@registry.test" }));
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ at: "cron.report-notices", reminded: 0, expired: 0, discarded: 0, sent: 0, skipped: 0, failed: 0 });
    log.mockRestore();
  });

  it("fails loudly without the registry security address", async () => {
    await expect(reportNotices(runtimeWith({ siteOrigin: "https://registry.test", securityAddress: "" }))).rejects.toThrow("security address");
  });
});
