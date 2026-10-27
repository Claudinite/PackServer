import { sha256Hex } from "@packserver/core/index";
import { MAX_UPLOAD_BYTES } from "@packserver/core/publishing";
import { migratedD1 } from "@packserver/core/identity/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import type { DurableObjects } from "@packserver/ports";
import { createFakePorts, FakeRateLimit } from "@packserver/ports/fakes";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app";
import type { PublishRuntime } from "../src/bindings";
import { MemoryDoStorage } from "../src/do-storage";
import { QuotaCounter } from "../src/quota";
import { ScopeCoordinatorLogic } from "../src/coordinator";
import { RootCoordinatorLogic } from "../src/root-coordinator";
import { issueCredential } from "../src/upload/credentials";

/** Runs each Durable Object call to completion before the next on the same object, as the platform does. */
export class LogicDurableObjects implements DurableObjects {
  readonly objects = new Map<string, { logic: Record<string, (...a: unknown[]) => Promise<unknown>>; tail: Promise<unknown> }>();
  readonly locks: string[] = [];
  constructor(private readonly make: (namespace: string, name: string) => Record<string, (...a: unknown[]) => Promise<unknown>>) {}
  async call(namespace: string, name: string, method: string, args: unknown[]): Promise<never> {
    const key = `${namespace}/${name}`;
    let entry = this.objects.get(key);
    if (!entry) this.objects.set(key, (entry = { logic: this.make(namespace, name), tail: Promise.resolve() }));
    const target = entry;
    const run = target.tail.then(() => target.logic[method]!(...args));
    target.tail = run.catch(() => undefined);
    return (await run) as never;
  }
}

/** A response body as the tests read it: the run view's fields typed, anything else left unknown. */
export interface Body {
  run_id: string;
  status: string;
  verdict: string | null;
  reason: string | null;
  queued: { reason: string; start_after: string; until: string } | null;
  milestones: Array<{ step: string; outcome: string; detail?: string }>;
  [key: string]: unknown;
}

export const ZSTD_BYTES = (size: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(size);
  out.set([0x28, 0xb5, 0x2f, 0xfd]);
  for (let i = 4; i < size; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

export interface ValidatorScript {
  requests: unknown[];
  status: number;
}

export function createWorld(options: { limit?: number } = {}) {
  const fakes = createFakePorts({ worker: "publish", rateLimits: { RATE_LIMIT: { limit: options.limit ?? 1000, periodMs: 60_000 } } });
  const { d1, db } = migratedD1();
  const clock = fakes.clock;
  const doStorage = new Map<string, MemoryDoStorage>();
  const rootSigns: unknown[] = [];
  const durableObjects = new LogicDurableObjects((namespace, name) => {
    const storage = new MemoryDoStorage();
    doStorage.set(`${namespace}/${name}`, storage);
    const now = () => clock.now();
    if (namespace === "Quota") return new QuotaCounter(storage, now) as never;
    if (namespace === "ScopeCoordinator") {
      return new ScopeCoordinatorLogic(storage, now, {
        d1,
        indexes: { rebuild: async () => ({ sha256: "a".repeat(64), serial: 1 }) },
        root: { scopeChanged: async () => undefined },
      }) as never;
    }
    return new RootCoordinatorLogic(storage, now, { signAndWriteRoot: async (r) => (rootSigns.push(r), { sha256: "b".repeat(64), serial: 1 }) }) as never;
  });
  const validator: ValidatorScript = { requests: [], status: 200 };
  const validatorFetcher = {
    fetch: async (_url: string, init: RequestInit) => {
      validator.requests.push(JSON.parse(init.body as string));
      if (validator.status !== 200) return new Response("no", { status: validator.status });
      const body = validator.requests.at(-1) as { run_id: string };
      return Response.json({ ok: true, run_id: body.run_id, workflow_instance_id: `wf-${body.run_id}` });
    },
  } as unknown as Fetcher;
  const web: { requests: Request[] } = { requests: [] };
  const webFetcher = {
    fetch: async (request: Request) => {
      web.requests.push(request);
      return Response.json({ from: "web" }, { status: 202 });
    },
  } as unknown as Fetcher;
  const runtime: PublishRuntime = {
    worker: "publish",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...fakes, d1, durableObjects, rateLimits: { RATE_LIMIT: new FakeRateLimit(clock, 1000, 60_000) } },
    services: { validator: validatorFetcher, web: webFetcher },
    config: {
      oidc: { issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks", audience: "registry.claudinite.com" },
      presigner: { presignPut: async () => ({ url: "https://s3.example/x", headers: {} }) },
      fetch,
    },
  };
  const app = createApp(runtime);
  const staging = fakes.r2.PACKS_STAGING!;

  const iso = () => new Date(clock.now()).toISOString();
  let n = 0;
  const seed = {
    user(opts: { id?: string; ageDays?: number } = {}) {
      const id = opts.id ?? `user${++n}`;
      db.prepare(`insert into users (id, handle, created_at) values (?, ?, ?)`).run(id, id, new Date(clock.now() - (opts.ageDays ?? 30) * 86_400_000).toISOString());
      return id;
    },
    scope(name: string, opts: { kind?: "org" | "synthetic"; state?: "active" | "held"; verifiedDomain?: string; members?: Array<[string, string]> } = {}) {
      const id = `scope-${name}`;
      db.prepare(`insert into scopes (id, name, kind, state, verified_domain, created_at) values (?, ?, ?, ?, ?, ?)`).run(id, name, opts.kind ?? "org", opts.state ?? "active", opts.verifiedDomain ?? null, iso());
      for (const [user, role] of opts.members ?? []) db.prepare(`insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, ?, ?)`).run(id, user, role, iso());
      return id;
    },
    pack(scopeId: string, name: string, visibility: "public" | "private" = "public") {
      const id = `pack-${scopeId}-${name}`;
      db.prepare(`insert into packs (id, scope_id, name, visibility, created_at) values (?, ?, ?, ?, ?)`).run(id, scopeId, name, visibility, iso());
      return id;
    },
    version(packId: string, version: string, published = true) {
      db.prepare(
        `insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values (?, ?, ?, ?, ?, 1, ?, 0, 0)`,
      ).run(`v-${packId}-${version}`, packId, version, published ? "active" : "approved", "c".repeat(64), published ? iso() : null);
    },
  };

  /** A credential whose upload has been confirmed with `bytes` in staging: what a publisher holds when it asks for a run. */
  async function staged(opts: {
    scope: string; pack: string; version: string; bytes?: Uint8Array; userId?: string; lifetime?: "draft" | "dry-run"; skipObject?: boolean;
  }) {
    const bytes = opts.bytes ?? ZSTD_BYTES(2048);
    const scopeId = `scope-${opts.scope}`;
    const issued = await issueCredential(runtime.ports, {
      source: opts.userId ? "upload" : "oidc",
      scope: { id: scopeId, name: opts.scope },
      packName: opts.pack,
      version: opts.version,
      lifetime: opts.lifetime ?? "draft",
      ...(opts.userId ? { userId: opts.userId } : {}),
    });
    if (!opts.skipObject) await staging.put(issued.stagingKey, bytes);
    db.prepare(`update upload_credentials set used_at = ?, uploaded_at = ?, size_bytes = ? where id = ?`).run(iso(), iso(), bytes.byteLength, issued.id);
    return { ...issued, bytes, sha256: await sha256Hex(bytes), path: `/api/publish/@${opts.scope}/${opts.pack}/${opts.version}` };
  }

  const post = (path: string, body: unknown, secret?: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, secret?: string) => app.request(path, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });

  /** Stages and starts a publish in one go. */
  async function publish(opts: Parameters<typeof staged>[0] & { sha256?: string }) {
    const credential = await staged(opts);
    const res = await post(credential.path, { sha256: opts.sha256 ?? credential.sha256 }, credential.secret);
    return { res, credential };
  }

  return { app, runtime, db, d1, clock, fakes, staging, seed, staged, post, get, publish, validator, web, doStorage, rootSigns, durableObjects, MAX_UPLOAD_BYTES };
}

export type TestWorld = ReturnType<typeof createWorld>;
export type { DatabaseSync };
