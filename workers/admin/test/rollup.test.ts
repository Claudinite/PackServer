import { SqliteD1 } from "@packserver/core/audit/testing";
import { MemoryAuditBucket } from "@packserver/core/audit/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { describe, expect, it, vi } from "vitest";
import type { AdminRuntime } from "../src/bindings";
import { CRON_DAILY, CRON_HOURLY, runCron } from "../src/crons";

function setup() {
  const fakes = createFakePorts({ worker: "admin" });
  const d1 = new SqliteD1();
  const runtime = {
    worker: "admin",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...fakes, d1, auditBucket: new MemoryAuditBucket(), r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! } },
    services: {},
    config: { siteOrigin: "https://registry.test", securityAddress: "security@registry.test" },
  } satisfies AdminRuntime;
  return { fakes, d1, runtime };
}

describe("fetch-count crons", () => {
  it("rolls the archive into pack_stats hourly, says so once, and ages the windows daily", async () => {
    const { fakes, d1, runtime } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await d1.query("insert into scopes (id, name, kind, state, created_at) values ('s', 'acme', 'org', 'active', 'x')");
    await d1.query("insert into packs (id, scope_id, name, visibility, created_at) values ('p', 's', 'x', 'public', 'x')");
    const day = new Date(fakes.clock.now()).toISOString();
    const record = { ClientRequestPath: "/@acme/x/1.0.0/pack.tar.zst", ClientRequestMethod: "GET", EdgeResponseStatus: 200, EdgeStartTimestamp: day, ClientNetwork: "198.51.100.0/24" };
    await fakes.r2["OPS_BUCKET"]!.put(`logs/http-requests/misses/${day.slice(0, 10).replaceAll("-", "")}/1.log`, new TextEncoder().encode(JSON.stringify(record)));

    await runCron(CRON_HOURLY, runtime);
    expect(d1.rows("select fetches_30d, fetches_7d from pack_stats")).toEqual([{ fetches_30d: 1, fetches_7d: 1 }]);
    const done = fakes.stats.points.filter((p) => p.name === "rollup.completed");
    expect(done).toHaveLength(1);
    expect(JSON.parse(String(done[0]!.blobs[3]))).toMatchObject({ job: "fetches", private: "not_configured" });

    fakes.clock.advance("40d");
    await runCron(CRON_DAILY, runtime);
    expect(d1.rows("select fetches_30d, fetches_7d, fetches_prev_28d from pack_stats")).toEqual([{ fetches_30d: 0, fetches_7d: 0, fetches_prev_28d: 0 }]);
    expect(d1.rows("select * from fetch_days")).toEqual([]);
  });
});
