import { createAudit, type AuditEvent } from "@packserver/core/audit";
import { MemoryAuditBucket, SqliteD1 } from "@packserver/core/audit/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { describe, expect, it, vi } from "vitest";
import type { AdminRuntime } from "../src/bindings";
import { runCron, CRON_DAILY } from "../src/crons";
import { appendBatch } from "@packserver/core/audit";

function setup() {
  const fakes = createFakePorts({ worker: "admin" });
  const d1 = new SqliteD1();
  const auditBucket = new MemoryAuditBucket();
  const runtime = {
    worker: "admin",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: {
      ...fakes, d1, auditBucket,
      r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! },
    },
    services: {},
  } satisfies AdminRuntime;
  return { fakes, d1, auditBucket, runtime };
}

describe("daily audit crons", () => {
  it("anchors the head through the transparency port and verifies the chain in the same run", async () => {
    const { fakes, d1, auditBucket, runtime } = setup();
    const queue = fakes.queues["AUDIT_QUEUE"]!;
    const audit = createAudit({ clock: fakes.clock, rng: fakes.rng, queue, d1 }, { ipKey: "k" });
    await audit({ kind: "system" }, "admin.action", "a");
    const events = (queue as unknown as { messages: AuditEvent[] }).messages;
    await appendBatch(auditBucket, events.map((event, i) => ({ messageId: `m${i}`, event })));
    fakes.clock.advance("5h");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCron(CRON_DAILY, runtime);

    expect(fakes.transparency.anchored).toHaveLength(1);
    expect(d1.rows("select day, seq from audit_heads")).toEqual([{ day: "2026-10-22", seq: 0 }]);
    expect(fakes.stats.points.map((p) => p.name)).toContain("audit.chain_verified");
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining('"at":"cron.audit-head"')]));
    log.mockRestore();
  });
});
