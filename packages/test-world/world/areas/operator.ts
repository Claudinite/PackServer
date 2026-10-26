import { SELFTEST_SIGNATURE_HEADER, signSelfTest } from "@packserver/core/selftest";
import { SELFTEST_CHECK_TIMEOUT_MS } from "@packserver/http";
import type { WorkerName } from "@packserver/ports";
import type { Driver } from "../../drivers/driver";
import { InfrastructureError } from "../errors";
import { Refusal } from "../outcomes";
import type { SelfTest, SelfTestCheck } from "../types";

/** Every Worker's `env.test` holds this as `SELFTEST_HMAC_KEY`; a test holds the two together. */
export const SELFTEST_TEST_KEY = "test-selftest-hmac-key";

/** Where each Worker answers its self-test on the canary host (and so in-process, so a scenario asks what a release would). */
export const SELFTEST_PATHS: Readonly<Record<WorkerName, string>> = {
  web: "/__selftest",
  mcp: "/mcp/__selftest",
  publish: "/api/publish/__selftest",
  github: "/github/__selftest",
  validator: "/validator/__selftest",
  admin: "/__selftest",
  judge: "/judge/__selftest",
  prober: "/prober/__selftest",
};

export interface SelfTestOptions {
  shallow?: boolean;
  worker?: string;
  /** The signing key id, which is the principal the rate limit counts; a fresh one per call unless named. */
  principal?: string;
}

export interface Operator {
  /** The Workers whose self-test this driver can reach: all that booted in-process, every Worker on the canary host over http but the admin one, which has a host of its own. */
  reachable(): readonly WorkerName[];
  selfTest(o?: SelfTestOptions): Promise<SelfTest>;
  /** Calls the shallow self-test as one principal until it is refused, up to a few calls past its budget. */
  drainSelfTestBudget(o?: { worker?: string; principal?: string }): Promise<{ answered: number; refusal: Refusal | undefined }>;
  deployedVersion(): string;
  observedVersions(): ReadonlySet<string>;
  /** Makes the dependency behind a check slower than its 2 s budget; only a check whose dependency is a fake can be stalled. */
  stall(check: string): void;
}

const STALLABLE: Readonly<Record<string, (driver: Driver) => void>> = {
  "outbound.github-app": (driver) => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fake GitHub to hold back`);
    driver.fakes.githubApp.stallMs = SELFTEST_CHECK_TIMEOUT_MS + 3_000;
  },
};

const DRAIN_LIMIT = 12;
const DRAIN_LIMIT_DEPLOYED = 120;
const OK = 200;
const RATE_LIMITED = 429;

interface Wire {
  version_id: string;
  release_id: string;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; ms: number; detail: string }>;
}

/** The release flow's identity. The version observations are the driver's; the self-test is called as the flow calls it, signed. */
export function createOperator(driver: Driver): Operator {
  const operator: Operator = {
    reachable: () => (driver.kind === "inprocess" ? driver.surfaces : (Object.keys(SELFTEST_PATHS) as WorkerName[]).filter((w) => w !== "admin")),
    async drainSelfTestBudget(o = {}) {
      const principal = o.principal ?? `op-${crypto.randomUUID().slice(0, 8)}`;
      // Over http the budget is each isolate's own, so a refusal may take many calls to arrive.
      const limit = driver.kind === "inprocess" ? DRAIN_LIMIT : DRAIN_LIMIT_DEPLOYED;
      for (let answered = 0; answered <= limit; answered++) {
        try {
          await operator.selfTest({ ...o, principal, shallow: true });
        } catch (error) {
          if (error instanceof Refusal) return { answered, refusal: error };
          throw error;
        }
      }
      return { answered: limit + 1, refusal: undefined };
    },
    async selfTest(o = {}) {
      const worker = (o.worker ?? "web") as WorkerName;
      const path = SELFTEST_PATHS[worker];
      if (!path) throw new InfrastructureError(`no self-test path is known for the ${worker} Worker`);
      const principal = o.principal ?? `op-${crypto.randomUUID().slice(0, 8)}`;
      const headers: Record<string, string> = {};
      // The http driver signs for itself with the key it was given; in-process the key is the one every Worker's env.test holds.
      if (driver.kind === "inprocess") {
        headers[SELFTEST_SIGNATURE_HEADER] = await signSelfTest({
          key: SELFTEST_TEST_KEY,
          keyId: principal,
          method: "GET",
          host: `${worker}.internal`,
          path,
          nowMs: Date.now(),
          nonce: crypto.randomUUID(),
        });
      }
      const res = await driver.http.request({ surface: worker, method: "GET", path: o.shallow ? `${path}?shallow=1` : path, headers, signAs: principal });
      if (res.status === RATE_LIMITED) throw new Refusal("rate-limited", { retryAfterS: Number(res.headers.get("retry-after")) });
      if (res.status !== OK) throw new InfrastructureError(`the self-test did not accept the probe credential (it answered ${res.status})`);
      const wire = res.json() as Wire;
      const checks: SelfTestCheck[] = wire.checks;
      return { ok: wire.ok, versionId: wire.version_id, releaseId: wire.release_id, checks, check: (name) => checks.find((c) => c.name === name) };
    },
    stall(check) {
      const hold = STALLABLE[check];
      if (!hold) throw new InfrastructureError(`${check} has no dependency the World can hold back`);
      hold(driver);
    },
    deployedVersion: () => driver.deployedVersion(),
    observedVersions: () => driver.observedVersions(),
  };
  return operator;
}
