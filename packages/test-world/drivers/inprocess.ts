import { TRUST_TABLE, type WorkerName } from "@packserver/ports";
import type { TestHarness } from "wrangler";
import { WorldFakes } from "../fakes/compose";
import { createWorldHarness, testWorkerName, type HarnessOptions, type WorldHarness } from "../harness";
import { InfrastructureError } from "../world/errors";
import { filterInvocations, invocationsFromLogs, type InvocationFilter, type InvocationView } from "../world/recorder";
import type { ApiRequest, ApiResponse, Capability, Driver, McpCredentials, OpsBucket, SeedStorage, StorageAccess, UiActions } from "./driver";
import { McpClient } from "./mcp";
import { encodeBody, toApiResponse, VersionObserver } from "./observe";

/** Failure attachments reach reporters, so credentials never travel in them. */
export function stripCredentials(text: string): string {
  return text
    .replace(/(authorization|cookie|set-cookie|cf-access-[a-z-]+|x-selftest-signature)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+(?: [^\s,;]+)?)/gi, "$1$2<redacted>")
    .replace(/\b(pks_|ghs_|ghp_|whsec_|psr_|psu_)\w+/g, "<redacted>")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<redacted>");
}

/** The slice of the publish Worker's bindings the driver reaches, typed here because this package does not load the Workers types. */
interface PublishStores {
  DB: { prepare(sql: string): { bind(...params: unknown[]): { all(): Promise<{ results?: unknown[] }> } } };
  PACKS_STAGING: {
    list(options: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string; size: number }>; truncated: boolean; cursor?: string }>;
    get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
    delete(key: string): Promise<void>;
  };
}

/** What the harness serves when a version is uploaded without a release tag. */
const HARNESS_RELEASE = "unreleased";
const MIGRATION_BINDING = "DB";

/**
 * All Workers in one local workerd under `createTestHarness`, each under its `env.test`, with
 * the fake Workers behind their service bindings and every outbound fetch answered by the fakes.
 */
export class InProcessDriver implements Driver {
  readonly kind = "inprocess" as const;
  static readonly CAPABILITIES: readonly Capability[] = ["fakes", "clock", "reset", "recorder", "mcp", "storage"];
  readonly capabilities: ReadonlySet<Capability> = new Set(InProcessDriver.CAPABILITIES);
  ui?: UiActions;
  /** Where the running harness listens, for a browser to reach it. */
  baseUrl?: URL;
  private harness!: WorldHarness;
  private readonly versions = new VersionObserver(new Set([HARNESS_RELEASE]));
  private logCursor = 0;
  fakes!: WorldFakes;

  constructor(private readonly options: HarnessOptions = {}) {}

  get surfaces(): readonly WorkerName[] {
    return this.harness.workers;
  }
  get server(): TestHarness {
    return this.harness.server;
  }

  async start(): Promise<void> {
    this.harness = createWorldHarness(this.options);
    this.fakes = new WorldFakes(this.harness.server, this.harness.fakes);
    this.fakes.net.listen();
    this.baseUrl = (await this.harness.server.listen()).url;
  }

  http = {
    request: async (req: ApiRequest): Promise<ApiResponse> => {
      if (!this.harness.workers.includes(req.surface)) throw new InfrastructureError(`the ${req.surface} Worker is not booted`);
      const headers = { ...req.headers };
      const url = `http://${req.surface}.internal${req.path}`;
      const body = encodeBody(req.body, headers);
      const res = await this.harness.server.getWorker(testWorkerName(req.surface)).fetch(url, { method: req.method, headers, redirect: "manual", ...(body === undefined ? {} : { body }) } as never);
      const out = await toApiResponse(res as unknown as Response);
      this.versions.check(url, out);
      return out;
    },
  };

  publishStorage: StorageAccess = {
    sql: async (statement, params = []) => {
      const env = await this.publishEnv();
      return ((await env.DB.prepare(statement).bind(...params).all()).results ?? []) as Array<Record<string, unknown>>;
    },
    staging: {
      list: async (prefix) => {
        const bucket = (await this.publishEnv()).PACKS_STAGING;
        const out: Array<{ key: string; size: number }> = [];
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
          out.push(...page.objects.map((o) => ({ key: o.key, size: o.size })));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return out;
      },
      get: async (key) => {
        const object = await (await this.publishEnv()).PACKS_STAGING.get(key);
        return object ? new Uint8Array(await object.arrayBuffer()) : null;
      },
      delete: async (key) => (await this.publishEnv()).PACKS_STAGING.delete(key),
    },
  };

  private async publishEnv() {
    if (!this.harness.workers.includes("publish")) throw new InfrastructureError("the publish Worker is not booted, so there is no registry database or staging bucket to reach");
    return this.harness.server.getWorker<PublishStores>(testWorkerName("publish")).getEnv();
  }

  async storage(): Promise<SeedStorage> {
    const env = (await this.harness.server.getWorker(testWorkerName("web")).getEnv()) as { DB: SeedStorage["db"]; PACKS_PUBLIC: SeedStorage["packsPublic"]; PACKS_PRIVATE: SeedStorage["packsPrivate"] };
    const ops = this.harness.workers.includes("admin") ? (await this.harness.server.getWorker<{ OPS_BUCKET: OpsBucket }>(testWorkerName("admin")).getEnv()).OPS_BUCKET : undefined;
    return { db: env.DB, packsPublic: env.PACKS_PUBLIC, packsPrivate: env.PACKS_PRIVATE, ...(ops && { ops }) };
  }

  mcp = { client: async (credentials?: McpCredentials) => new McpClient((req) => this.http.request(req), credentials) };

  observedVersions() {
    return this.versions.observed;
  }
  deployedVersion() {
    return HARNESS_RELEASE;
  }

  /** The Worker that owns the shared registry database applies its migrations; every Worker's `env.test` points at the same one. */
  private async migrate(): Promise<void> {
    const owner = this.harness.workers.find((w) => MIGRATION_BINDING in TRUST_TABLE[w].d1);
    if (owner) await this.harness.server.getWorker(testWorkerName(owner)).applyD1Migrations(MIGRATION_BINDING);
  }

  async reset(): Promise<void> {
    await this.harness.server.reset();
    await this.migrate();
    this.harness.server.clearLogs();
    this.logCursor = 0;
    await this.beginScenario();
  }

  async beginScenario(): Promise<void> {
    await this.fakes.reset();
    this.harness.server.clearLogs();
    this.logCursor = 0;
    this.versions.clear();
  }

  recorder = {
    invocations: (filter?: InvocationFilter): InvocationView[] =>
      filterInvocations(filter?.raw ? this.fakes.net.requests() : invocationsFromLogs(this.harness.server.getLogs().map((l) => l.message)), filter),
    clear: () => this.harness.server.clearLogs(),
  };

  async diagnostics(): Promise<Record<string, unknown>> {
    const logs = this.harness.server.getLogs().slice(this.logCursor);
    return {
      driver: this.kind,
      logs: logs.map((l) => stripCredentials(`${l.level} ${l.message}`)),
      invocations: this.recorder.invocations(),
      egress: this.fakes.net.requests(),
      staging: this.fakes.stagingS3?.requests() ?? [],
    };
  }

  async dispose(): Promise<void> {
    this.fakes?.net.close();
    await this.harness?.server.close();
  }
}
