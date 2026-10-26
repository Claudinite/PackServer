import type { Queue as CfQueue, RateLimit as CfRateLimit, Workflow as CfWorkflow } from "@cloudflare/workers-types";
import type { SyncedClock } from "../src/clock";
import { missingBindings, TRUST_TABLE, type WorkerName } from "../src/trust-table";
import {
  PortError,
  type Clock,
  type D1,
  type D1Result,
  type DoNamespace,
  type DurableObjects,
  type Embedder,
  type KV,
  type Queue,
  type R2,
  type R2Read,
  type RateLimit,
  type Rng,
  type Sandbox,
  type AccessIdentity,
  type Turnstile,
  type VectorIndex,
  type Workflow,
} from "../src/ports";

// The production adapters over Cloudflare bindings. A Worker's `bindings.ts` is the only caller
// (tools/check-bindings.mjs), so this is the one place a binding's own API is spoken.

export * from "./email-service";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
const KV_MIN_TTL_S = 60;

export function d1Port(db: D1Database): D1 {
  const run = async (sql: string, params: unknown[]): Promise<D1Result> => {
    const r = await db.prepare(sql).bind(...params).all();
    return { rows: r.results as Array<Record<string, unknown>>, meta: { changes: r.meta.changes, last_row_id: r.meta.last_row_id ?? null } };
  };
  return {
    query: (sql, params = []) => run(sql, params),
    async batch(statements) {
      const results = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))));
      return results.map((r) => ({
        rows: r.results as Array<Record<string, unknown>>,
        meta: { changes: r.meta.changes, last_row_id: r.meta.last_row_id ?? null },
      }));
    },
  };
}

export function r2ReadPort(bucket: R2Bucket): R2Read {
  return {
    async get(key) {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async head(key) {
      const object = await bucket.head(key);
      return object ? { size: object.size } : null;
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        keys.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys;
    },
  };
}

export function r2Port(bucket: R2Bucket): R2 {
  return {
    ...r2ReadPort(bucket),
    async put(key, body, options) {
      await bucket.put(key, body, options?.content_type ? { httpMetadata: { contentType: options.content_type } } : undefined);
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

export function kvPort(namespace: KVNamespace): KV {
  return {
    get: (key) => namespace.get(key),
    async put(key, value, options) {
      const ttl = options?.ttl_seconds;
      if (ttl !== undefined && ttl < KV_MIN_TTL_S) throw new PortError("kv_ttl_below_minimum", `KV expiry is at least ${KV_MIN_TTL_S} seconds`);
      await namespace.put(key, value, ttl === undefined ? undefined : { expirationTtl: ttl });
    },
    delete: (key) => namespace.delete(key),
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await namespace.list({ prefix, ...(cursor ? { cursor } : {}) });
        keys.push(...page.keys.map((k) => k.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return keys;
    },
  };
}

export function queuePort(queue: CfQueue): Queue {
  return {
    async send(message) {
      await queue.send(message);
    },
    async sendBatch(messages) {
      await queue.sendBatch(messages.map((body) => ({ body })));
    },
  };
}

export function workflowPort(workflow: CfWorkflow): Workflow {
  return {
    async create(request) {
      const instance = await workflow.create({ ...(request.id ? { id: request.id } : {}), params: request.params });
      return { id: instance.id };
    },
    async status(id) {
      const { status } = await (await workflow.get(id)).status();
      return { status };
    },
  };
}

export function rateLimitPort(binding: CfRateLimit): RateLimit {
  return { limit: (request) => binding.limit(request) };
}

export type DurableObjectBindings = { [D in DoNamespace]?: DurableObjectNamespace };
export function durableObjectsPort(bindings: DurableObjectBindings): DurableObjects {
  return {
    async call(namespace, name, method, args) {
      const binding = bindings[namespace];
      if (!binding) throw new PortError("no_binding", `this Worker has no ${namespace} binding`);
      const stub = binding.getByName(name) as unknown as Record<string, (...a: unknown[]) => Promise<never>>;
      return stub[method as string]!(...(args as unknown[]));
    },
  };
}

/** Whether a binding is a service binding (the test environment's fake Workers) rather than the product binding it stands in for. */
export function isServiceBinding(binding: unknown): binding is Fetcher {
  return typeof (binding as { fetch?: unknown } | undefined)?.fetch === "function";
}

/** A fake Worker implements the port's methods as RPC, so the service binding is the port. */
export const rpcPort = <P>(binding: Fetcher): P => binding as unknown as P;

export function vectorizePort(index: VectorizeIndex): VectorIndex {
  return {
    async upsert(items) {
      await index.upsert(items.map((i) => ({ id: i.id, values: i.vector, ...(i.metadata ? { metadata: i.metadata } : {}) })));
    },
    async query(vector, options) {
      const result = await index.query(vector, { topK: options.topK, returnMetadata: "all" });
      return result.matches.map((m) => ({ id: m.id, score: m.score, metadata: (m.metadata ?? {}) as Record<string, string | number | boolean> }));
    },
    async deleteByIds(ids) {
      await index.deleteByIds(ids);
    },
  };
}

export function embedderPort(ai: Ai): Embedder {
  return {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts) {
      const result = (await ai.run(EMBEDDING_MODEL as never, { text: texts } as never)) as { data?: number[][] };
      if (!result.data || result.data.length !== texts.length) throw new PortError("embedding_shape", "the embedding model returned an unexpected shape");
      return result.data;
    },
  };
}

/** Secrets Store bindings in staging and production, plain test values under `env.test`. */
export async function readSecret(binding: string | SecretsStoreSecret | undefined): Promise<string> {
  if (typeof binding === "string") return binding;
  if (!binding) throw new PortError("secret_missing", "the secret is not bound");
  return binding.get();
}

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export function turnstilePort(secret: () => Promise<string>, fetcher: typeof fetch = fetch): Turnstile {
  return {
    async verify(token, remoteIp) {
      const body = new URLSearchParams({ secret: await secret(), response: token });
      if (remoteIp) body.set("remoteip", remoteIp);
      const response = await fetcher(TURNSTILE_VERIFY_URL, { method: "POST", body });
      if (!response.ok) return { success: false, codes: ["siteverify-unavailable"] };
      const result = (await response.json()) as { success?: boolean; "error-codes"?: string[] };
      return { success: result.success === true, codes: result["error-codes"] ?? [] };
    },
  };
}

export const systemClock: Clock = { now: () => Date.now() };

/** The system clock in staging and production; under `env.test`, the instant the fake clock Worker reports as of the last `sync()`. */
export function clockFrom(environment: string, binding: Fetcher | undefined): Clock {
  if (environment !== "test" || binding === undefined) return systemClock;
  const fake = rpcPort<{ now(): Promise<number> }>(binding);
  let ms = Date.now();
  const clock: SyncedClock = {
    now: () => ms,
    async sync() {
      ms = await fake.now();
    },
  };
  return clock;
}

export const cryptoRng: Rng = {
  float: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296,
  uuid: () => crypto.randomUUID(),
  bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};

/** A port whose production adapter belongs to a task that has not landed; every call says so rather than doing nothing. */
export function unwiredPort<P extends object>(name: string): P {
  return new Proxy({} as P, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return () => {
        throw new PortError("not_wired", `${name}.${method} has no production adapter yet`);
      };
    },
  });
}

/** What the version metadata binding says; a version uploaded without a tag reports itself as unreleased. */
export function versionInfo(metadata: { id: string; tag?: string } | undefined): { versionId: string; releaseId: string } {
  return { versionId: metadata?.id ?? "unknown", releaseId: metadata?.tag || "unreleased" };
}

/** What a Worker's `bindings.ts` hands its app: ports, the raw service bindings, and what is missing from `env`. */
export interface WorkerRuntime<P, S = Record<string, never>> {
  worker: WorkerName;
  environment: string;
  version: { versionId: string; releaseId: string };
  missingBindings: string[];
  missingSecrets: string[];
  /** Reads `SELFTEST_HMAC_KEY` when the Worker is given one; absent leaves the signed self-test path closed. */
  selfTestKey?: () => Promise<string>;
  ports: P;
  services: S;
}

export function workerRuntime<P, S = Record<string, never>>(
  worker: WorkerName,
  env: { ENVIRONMENT: string; CF_VERSION_METADATA?: { id: string; tag?: string }; SELFTEST_HMAC_KEY?: string | SecretsStoreSecret },
  ports: P,
  services?: S,
): WorkerRuntime<P, S> {
  const absent = missingBindings(worker, env);
  const secrets = new Set<string>(TRUST_TABLE[worker].secrets);
  return {
    worker,
    environment: env.ENVIRONMENT,
    version: versionInfo(env.CF_VERSION_METADATA),
    missingBindings: absent.filter((n) => !secrets.has(n)),
    missingSecrets: absent.filter((n) => secrets.has(n)),
    ...(env.SELFTEST_HMAC_KEY === undefined ? {} : { selfTestKey: () => readSecret(env.SELFTEST_HMAC_KEY) }),
    ports,
    services: services ?? ({} as S),
  };
}

/**
 * Whether a binding is a fake Worker is decided by `ENVIRONMENT`, never by the binding's shape: only `env.test` takes the fake path,
 * and a binding that disagrees with its environment is refused rather than guessed at. A missing binding is left to `missingBindings`.
 */
function takesFake(environment: string, name: string, binding: unknown): boolean {
  const fake = environment === "test";
  if (binding !== undefined && isServiceBinding(binding) !== fake) {
    throw new PortError("binding_shape", `${name} is ${fake ? "not a fake Worker" : "a service binding"} in env.${environment}`);
  }
  return fake;
}

/** Product Vectorize in staging and production, the fake Worker's RPC under `env.test`. */
export function vectorIndexPort(environment: string, binding: VectorizeIndex | Fetcher): VectorIndex {
  return takesFake(environment, "VECTORIZE", binding) ? rpcPort<VectorIndex>(binding as Fetcher) : vectorizePort(binding as VectorizeIndex);
}

/** Product Workers AI in staging and production, the fake Worker's RPC under `env.test`. */
export function embedderFrom(environment: string, binding: Ai | Fetcher): Embedder {
  if (!takesFake(environment, "AI", binding)) return embedderPort(binding as Ai);
  const fake = rpcPort<Pick<Embedder, "embed">>(binding as Fetcher);
  return { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, embed: (texts) => fake.embed(texts) };
}

/** The two fake sandbox Workers under `env.test`; the Containers adapter is not written yet. */
export function sandboxPort(environment: string, a: DurableObjectNamespace | Fetcher, b: DurableObjectNamespace | Fetcher): Sandbox {
  const fakeA = takesFake(environment, "SANDBOX_A", a);
  const fakeB = takesFake(environment, "SANDBOX_B", b);
  if (!fakeA || !fakeB) return unwiredPort<Sandbox>("sandbox");
  const sandboxA = rpcPort<Sandbox>(a as Fetcher);
  const sandboxB = rpcPort<Sandbox>(b as Fetcher);
  return { inspect: (request) => sandboxA.inspect(request), run: (request) => sandboxB.run(request) };
}

/** The fake Access Worker under `env.test`; verifying a real assertion is not written yet. */
export function accessPort(environment: string, binding: Fetcher | undefined): AccessIdentity {
  return binding !== undefined && takesFake(environment, "ACCESS", binding) ? rpcPort<AccessIdentity>(binding) : unwiredPort<AccessIdentity>("access");
}
