import { analyticsStats } from "@packserver/http";
import {
  accessPort, cryptoRng, d1Port, queuePort, r2Port, r2ReadPort, systemClock, workerRuntime, workflowPort,
  type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports, R2, R2Read } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  DB: D1Database;
  PACKS_STAGING: R2Bucket;
  VALIDATION_REPORTS: R2Bucket;
  OPS_BUCKET: R2Bucket;
  AUDIT_QUEUE: Queue;
  VALIDATE_PACK: Workflow;
  ACCESS?: Fetcher;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** The admin Worker writes no public or private bucket; reports and `ops` are read-only here. */
export type AdminPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "queues" | "workflows" | "access"> & {
  r2: Readonly<{ PACKS_STAGING: R2; VALIDATION_REPORTS: R2Read; OPS_BUCKET: R2Read }>;
};
export type AdminRuntime = WorkerRuntime<AdminPorts>;

export function createRuntime(env: Env): AdminRuntime {
  return workerRuntime("admin", env, {
    clock: systemClock,
    rng: cryptoRng,
    d1: d1Port(env.DB),
    stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS }),
    r2: {
      PACKS_STAGING: r2Port(env.PACKS_STAGING),
      VALIDATION_REPORTS: r2ReadPort(env.VALIDATION_REPORTS),
      OPS_BUCKET: r2ReadPort(env.OPS_BUCKET),
    },
    queues: { AUDIT_QUEUE: queuePort(env.AUDIT_QUEUE) },
    workflows: { VALIDATE_PACK: workflowPort(env.VALIDATE_PACK) },
    access: accessPort(env.ENVIRONMENT, env.ACCESS),
  });
}
