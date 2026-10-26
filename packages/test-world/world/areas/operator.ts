import { SELFTEST_SIGNATURE_HEADER, signSelfTest } from "@packserver/core/selftest";
import { PROBE_PACK, PROBE_REPOSITORY_NAME, PROBE_SCOPE, PROBE_WORKFLOW, provisionProbeTenant } from "@packserver/core/synthetic";
import { SESSION_COOKIE } from "@packserver/http";
import type { D1, D1Result } from "@packserver/ports";
import { SELFTEST_CHECK_TIMEOUT_MS } from "@packserver/http";
import type { WorkerName } from "@packserver/ports";
import type { Driver } from "../../drivers/driver";
import { InfrastructureError } from "../errors";
import type { CiModule, CiRepo, CiWorkflow, UploadCredential } from "../ci-workflow";
import { Refusal } from "../outcomes";
import type { ArchiveHandle, Run } from "../publishing";
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

/** The two ways the probe reaches the registry (REQ-OPS-002). */
export type ProbeIdentity = "repository" | "prober";

/** What a stolen probe credential might be used for, in the registry's terms. */
export type ProbeAction =
  | "publish-other-pack"
  | "read-private-pack"
  | "mint-token"
  | "list-sessions"
  | "change-email"
  | "create-pack-in-probe"
  | "publish-new-version-of-probe-pack";

export interface ProbePublisher {
  readonly repo: CiRepo;
  readonly workflow: CiWorkflow;
  /** Stages and starts a version of `@probe/p` through the workflow's own credential, then waits for the validator to finish the run. */
  publish(archive: ArchiveHandle, version: string): Promise<Run>;
  /** The workflow asking to publish `pack` at `version`: a credential, or the refusal. */
  exchange(pack: string, version: string): Promise<UploadCredential | Refusal>;
}

export interface Probe {
  /** Makes `@probe` a synthetic scope and registers the probe repository as the trusted publisher of `@probe/p`. */
  publisher(): Promise<ProbePublisher>;
  /**
   * Tries the action with the identity's credential. `asSession` presents that credential where a browser session
   * belongs instead. True when the registry did it.
   */
  attempt(identity: ProbeIdentity, action: ProbeAction, o?: { asSession?: boolean }): Promise<boolean>;
}

const PROBE_REPOSITORY = { slug: `Claudinite/${PROBE_REPOSITORY_NAME}`, id: 7_100_001, ownerId: 7_100_002 } as const;

interface Call {
  surface: WorkerName;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}
/** Each action as a request to the surface that serves it. The two that publish are, for the repository, the exchange itself. */
const callsFor = (probeScope: string): Record<ProbeAction, Call> => ({
  "publish-other-pack": { surface: "publish", method: "POST", path: "/api/publish/@acme/x/1.0.0/upload-url", body: { content_length: 1 } },
  "read-private-pack": { surface: "web", method: "GET", path: "/api/private/index?pack=@acme/secret" },
  "mint-token": { surface: "web", method: "POST", path: "/api/tokens", body: { scope: "acme" } },
  "list-sessions": { surface: "web", method: "GET", path: "/api/auth/sessions" },
  "change-email": { surface: "web", method: "POST", path: "/api/account/email", body: { email: "probe@example.test" } },
  "create-pack-in-probe": { surface: "publish", method: "POST", path: `/api/publish/@${probeScope}/created/1.0.0/upload-url`, body: { content_length: 1 } },
  "publish-new-version-of-probe-pack": { surface: "publish", method: "POST", path: `/api/publish/@${probeScope}/${PROBE_PACK}/1.1.0/upload-url`, body: { content_length: 1 } },
});
const EXCHANGES: Partial<Record<ProbeAction, [pack: string, version: string]>> = {
  "publish-other-pack": ["@acme/x", "1.0.0"],
  "create-pack-in-probe": [`@${PROBE_SCOPE}/created`, "1.0.0"],
  "publish-new-version-of-probe-pack": [`@${PROBE_SCOPE}/${PROBE_PACK}`, "1.1.0"],
};

/** The probe as the registry sees it: a repository running a workflow, and the prober Worker; both confined to `@probe`. */
export function createProbe(driver: Driver, ci: CiModule, alias: (name: string) => string, publishFromCi: (credential: UploadCredential, archive: ArchiveHandle) => Promise<Run>): { probe: Probe } {
  const storage = () => {
    if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver has no storage access: the synthetic tenant cannot be provisioned from here`);
    return driver.publishStorage;
  };
  const d1 = (): D1 => ({
    query: async (statement, params = []) => ({ rows: await storage().sql(statement, params), meta: { changes: 0, last_row_id: null } }),
    batch: async (statements) => {
      const out: D1Result[] = [];
      for (const s of statements) out.push({ rows: await storage().sql(s.sql, s.params ?? []), meta: { changes: 0, last_row_id: null } });
      return out;
    },
  });
  let publisher: ProbePublisher | undefined;

  const probe: Probe = {
    async publisher() {
      if (publisher) return publisher;
      await provisionProbeTenant(d1(), {
        repository: { slug: PROBE_REPOSITORY.slug, id: String(PROBE_REPOSITORY.id), ownerId: String(PROBE_REPOSITORY.ownerId) },
        nowMs: await driver.fakes!.clock.call<number>("now"),
        scope: alias(PROBE_SCOPE),
      });
      const repo = ci.ci.repo(PROBE_REPOSITORY.slug, { id: PROBE_REPOSITORY.id, ownerId: PROBE_REPOSITORY.ownerId });
      const workflow = ci.ci.workflow({ repo, workflowFile: PROBE_WORKFLOW, ref: "refs/heads/main", event: "schedule", refProtected: true });
      publisher = {
        repo,
        workflow,
        exchange: (pack, version) => workflow.exchange(pack, version),
        async publish(archive, version) {
          const credential = await workflow.exchange(`@${PROBE_SCOPE}/${PROBE_PACK}`, version);
          if (credential instanceof Refusal) throw credential;
          return publishFromCi(credential, archive);
        },
      };
      return publisher;
    },

    async attempt(identity, action, o = {}) {
      const workflow = (await probe.publisher()).workflow;
      const exchange = EXCHANGES[action];
      if (identity === "repository" && exchange && !o.asSession) return !((await workflow.exchange(...exchange)) instanceof Refusal);
      const headers: Record<string, string> = {};
      if (identity === "repository") {
        const value = await workflow.oidcToken();
        if (o.asSession) headers.cookie = `${SESSION_COOKIE}=${value}`;
        else headers.authorization = `Bearer ${value}`;
      } else if (o.asSession) {
        headers.cookie = `${SESSION_COOKIE}=prober`;
      } else {
        headers["cf-access-client-id"] = "prober.access";
        headers["cf-access-client-secret"] = "prober-service-token";
        headers["x-packserver-caller"] = "prober";
      }
      const call = callsFor(alias(PROBE_SCOPE))[action];
      const res = await driver.http.request({ surface: call.surface, method: call.method, path: call.path, headers, ...(call.body === undefined ? {} : { body: call.body }) });
      return res.status >= 200 && res.status < 300;
    },
  };
  return { probe };
}
