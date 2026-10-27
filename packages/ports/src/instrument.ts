import { RESPONSE_HEADER_ALLOWLIST, type InvocationKind } from "@packserver/schema";
import { assertNoCatchAllGrant, type ClassRules, type DataClass } from "./classification";
import type { BindingPorts, DoArgs, DoMethod, DoNamespace, DoResult, Ports, SinglePorts } from "./ports";
import type { InvokeSpec, Recorder } from "./recorder";

type Effect = InvokeSpec["effect"];
type Blanket = "secret" | "personal" | "customer-content";
type FunctionKeys<P> = { [K in keyof P]: P[K] extends (...args: never[]) => unknown ? K : never }[keyof P];

/**
 * The classification a type demands: every field of an object, including optional ones, must be
 * named, so adding a field to a port's type does not compile until someone classifies it. A
 * sensitive class on a container covers everything inside it; bytes and `unknown` are leaves.
 */
export type ClassTree<T> = Tree<NonNullable<T>>;
type Tree<T> = unknown extends T
  ? DataClass
  : [T] extends [Uint8Array | ArrayBuffer]
    ? DataClass
    : [T] extends [readonly (infer U)[]]
      ? Blanket | { "*": ClassTree<U> }
      : [T] extends [object]
        ? [string] extends [keyof T]
          ? Blanket
          : Blanket | { [K in keyof Required<T>]: ClassTree<Required<T>[K]> }
        : DataClass;
export type ArgsTree<A extends unknown[]> = { [I in keyof A]-?: ClassTree<A[I]> };
type ResultTree<R> = [Awaited<R>] extends [void] ? { result?: undefined } : { result: ClassTree<Awaited<R>> };

type StaticMethodSpec<F> = F extends (...args: infer A) => infer R
  ? { effect: Effect | ((args: A) => Effect) } & ResultTree<R> &
      (
        | { args: ArgsTree<A>; sqlRequest?: undefined }
        | { sqlRequest: (args: A) => { sql: string; params: unknown[] }; args?: undefined }
      )
  : never;

export interface PortSpec<P> {
  kind: InvocationKind;
  target: string;
  /** Exhaustive by type: a new port method does not compile until it is classified here. */
  methods: { [M in FunctionKeys<P>]: StaticMethodSpec<P[M]> };
}

/** For a port whose operation is named by an argument (the Durable Object RPC). */
export interface DynamicPortSpec {
  kind: InvocationKind;
  target: string;
  method: string;
  resolve: (args: unknown[]) => { op: string; effect: Effect; rules: ClassRules };
}

export function treeRules(tree: unknown, path: string, out: Record<string, DataClass> = {}): ClassRules {
  if (tree === undefined) return out;
  if (typeof tree === "string") out[path] = tree as DataClass;
  else for (const [k, t] of Object.entries(tree as object)) treeRules(t, `${path}.${k}`, out);
  return out;
}

interface RuntimeMethod {
  effect: Effect | ((args: unknown[]) => Effect);
  args?: unknown;
  result?: unknown;
  sqlRequest?: (args: unknown[]) => { sql: string; params: unknown[] };
}

const SQL_RULES: ClassRules = {
  "request.sql": "operational",
  "request.tables.*": "operational",
  "request.params": "customer-content",
};

/** Wraps `port` so each call goes through the Recorder; `target` defaults to the spec's and names the binding for per-binding ports. */
export function instrument<P extends object>(
  port: P,
  spec: PortSpec<P> | DynamicPortSpec,
  recorder: Recorder,
  target: string = spec.target,
): P {
  const staticMethods = "methods" in spec ? (spec.methods as Record<string, RuntimeMethod>) : {};
  return new Proxy(port, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop) as unknown;
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const call = (args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(obj, args);
      if ("resolve" in spec) {
        if (prop !== spec.method) throw new Error(`port method ${target}.${prop} has no recorder classification`);
        return (...args: unknown[]) => {
          const r = spec.resolve(args);
          assertNoCatchAllGrant(r.rules);
          return recorder.invoke(
            { kind: spec.kind, target, op: r.op, effect: r.effect, request: { args }, rules: r.rules },
            () => call(args),
          );
        };
      }
      const m = staticMethods[prop];
      if (!m) throw new Error(`port method ${target}.${prop} has no recorder classification`);
      return (...args: unknown[]) =>
        recorder.invoke(
          {
            kind: spec.kind,
            target,
            op: prop,
            effect: typeof m.effect === "function" ? m.effect(args) : m.effect,
            request: m.sqlRequest ? m.sqlRequest(args) : { args },
            rules: {
              ...(m.sqlRequest ? SQL_RULES : treeRules(m.args, "request.args")),
              ...treeRules(m.result, "result"),
            },
          },
          () => call(args),
        );
    },
  });
}

const op = "operational";
const content = "customer-content";
const isRead = (sql: unknown): Effect => (/^\s*(select|pragma|with)\b/i.test(String(sql)) ? "read" : "write");

const cacheHeaders = Object.fromEntries(RESPONSE_HEADER_ALLOWLIST.map((h) => [h, op])) as {
  [H in (typeof RESPONSE_HEADER_ALLOWLIST)[number]]: "operational";
};

export const PORT_SPECS: { [K in Exclude<keyof SinglePorts, "durableObjects">]: PortSpec<SinglePorts[K]> } = {
  clock: { kind: "clock", target: "clock", methods: { now: { effect: "read", args: [], result: op } } },
  rng: {
    kind: "random",
    target: "rng",
    methods: {
      float: { effect: "read", args: [], result: op },
      uuid: { effect: "read", args: [], result: op },
      bytes: { effect: "read", args: [op], result: "secret" },
    },
  },
  github: {
    kind: "http",
    target: "api.github.com",
    methods: {
      getRepo: { effect: "read", args: [op], result: { slug: op, id: op, default_branch: op, private: op, archived: op } },
      getRef: { effect: "read", args: [op, op], result: { sha: op } },
      getTree: { effect: "read", args: [op, op], result: { "*": { path: content, mode: op, type: op, sha: op, size: op } } },
      getBlob: { effect: "read", args: [op, op], result: content },
      getFile: { effect: "read", args: [op, op, op], result: content },
      searchCode: { effect: "read", args: [op], result: { "*": { repo: op, path: content } } },
    },
  },
  oidc: {
    kind: "http",
    target: "token.actions.githubusercontent.com",
    methods: {
      verify: {
        effect: "read",
        args: ["secret", { audience: op }],
        result: {
          iss: op, aud: op, sub: op, repository: op, repository_owner: op, repository_id: op, ref: op,
          ref_protected: op, job_workflow_ref: op, event_name: op, run_id: op, jti: op, iat: op, exp: op,
        },
      },
    },
  },
  vectors: {
    kind: "vectorize",
    target: "vectors",
    methods: {
      upsert: { effect: "write", args: [{ "*": { id: op, vector: content, metadata: content } }] },
      query: { effect: "read", args: [content, { topK: op }], result: { "*": { id: op, score: op, metadata: content } } },
      deleteByIds: { effect: "write", args: [{ "*": op }] },
    },
  },
  embedder: { kind: "service", target: "embedder", methods: { embed: { effect: "read", args: [content], result: content } } },
  sandbox: {
    kind: "service",
    target: "sandbox",
    methods: {
      inspect: {
        effect: "read",
        args: [{ upload: content, request: content }],
        result: { report: content, canonical: content },
      },
      run: {
        effect: "read",
        args: [{ canonical: content, request: content, engines: { "*": { file: op, bytes: content } } }],
        result: { report: content },
      },
    },
  },
  proseScreen: {
    kind: "service",
    target: "prose-screen",
    methods: {
      screen: {
        effect: "read",
        args: [{ nonce: op, chunks: { "*": { id: op, text: content } } }],
        result: { implementation: op, model_version: op, chunks: { "*": { id: op, probabilities: content } } },
      },
    },
  },
  mail: {
    kind: "http",
    target: "mail",
    methods: {
      send: { effect: "external_side_effect", args: [{ to: "personal", subject: content, text: content, html: content }], result: { id: op } },
    },
  },
  dns: { kind: "http", target: "dns-over-https", methods: { resolveTxt: { effect: "read", args: [op], result: { "*": op } }, resolves: { effect: "read", args: [op], result: op } } },
  wellKnown: {
    kind: "http",
    target: "well-known",
    methods: { authFile: { effect: "read", args: [op], result: { status: op, body: content, reason: op } } },
  },
  turnstile: {
    kind: "http",
    target: "challenges.cloudflare.com",
    methods: { verify: { effect: "read", args: ["secret", "personal"], result: { success: op, codes: { "*": op } } } },
  },
  access: {
    kind: "http",
    target: "access",
    methods: { verify: { effect: "read", args: ["secret"], result: { email: "personal", sub: "personal", aud: { "*": op }, exp: op } } },
  },
  stats: {
    kind: "ae",
    target: "stats",
    methods: { write: { effect: "write", args: [{ name: op, blobs: content, doubles: { "*": op }, index: op }] } },
  },
  telemetry: {
    kind: "kv",
    target: "telemetry",
    methods: {
      keys: { effect: "read", args: [], result: { ipMaster: "secret", principalKey: "secret" } },
      mode: { effect: "read", args: [], result: op },
    },
  },
  cache: {
    kind: "http",
    target: "cache",
    methods: {
      get: { effect: "read", args: [op], result: { status: op, headers: cacheHeaders, body: content } },
      put: { effect: "write", args: [op, { status: op, headers: cacheHeaders, body: content }] },
      purge: { effect: "write", args: [op], result: op },
    },
  },
  uploads: {
    kind: "r2",
    target: "uploads",
    methods: {
      create: {
        effect: "write",
        args: [{ key: op, max_bytes: op, content_type: op }],
        result: { key: op, url: "secret", expires_at: op },
      },
      stat: { effect: "read", args: [op], result: { size: op, sha256: op } },
      read: { effect: "read", args: [op], result: content },
    },
  },
  audit: {
    kind: "r2",
    target: "audit",
    methods: {
      append: { effect: "write", args: [content], result: { seq: op, prev_hash: op, hash: op, event: content } },
      head: { effect: "read", args: [], result: { seq: op, hash: op } },
    },
  },
  transparency: {
    kind: "http",
    target: "rekor",
    methods: { anchor: { effect: "external_side_effect", args: [{ seq: op, hash: op }], result: { log_index: op, anchored_hash: op } } },
  },
  d1: {
    kind: "d1",
    target: "d1",
    methods: {
      query: {
        effect: (args) => isRead(args[0]),
        sqlRequest: (args) => ({ sql: args[0], params: args[1] ?? [] }),
        result: { rows: content, meta: { changes: op, last_row_id: op } },
      },
      batch: {
        effect: (args) => (args[0].every((s) => isRead(s.sql) === "read") ? "read" : "write"),
        sqlRequest: (args) => ({
          sql: args[0].map((s) => s.sql).join(";\n"),
          params: args[0].map((s) => s.params ?? []),
        }),
        result: { "*": { rows: content, meta: { changes: op, last_row_id: op } } },
      },
    },
  },
};

/** One entry per binding-held port; the binding's name is the record's target. */
export const BINDING_SPECS: { [K in keyof BindingPorts]: PortSpec<BindingPorts[K]> } = {
  r2: {
    kind: "r2",
    target: "r2",
    methods: {
      get: { effect: "read", args: [op], result: content },
      head: { effect: "read", args: [op], result: { size: op } },
      put: { effect: "write", args: [op, content, { content_type: op, content_disposition: op, cache_control: op }] },
      putIfAbsent: { effect: "write", args: [op, content, { content_type: op, content_disposition: op, cache_control: op }], result: op },
      delete: { effect: "write", args: [op] },
      list: { effect: "read", args: [op], result: { "*": op } },
    },
  },
  kv: {
    kind: "kv",
    target: "kv",
    methods: {
      get: { effect: "read", args: [op], result: content },
      put: { effect: "write", args: [op, content, { ttl_seconds: op }] },
      delete: { effect: "write", args: [op] },
      list: { effect: "read", args: [op], result: { "*": op } },
    },
  },
  queues: {
    kind: "queue",
    target: "queue",
    methods: {
      send: { effect: "write", args: [content] },
      sendBatch: { effect: "write", args: [content] },
    },
  },
  workflows: {
    kind: "workflow",
    target: "workflow",
    methods: {
      create: { effect: "write", args: [{ id: op, params: content }], result: { id: op } },
      status: { effect: "read", args: [op], result: { status: op } },
      sendEvent: { effect: "write", args: [op, { type: op, payload: content }] },
    },
  },
  rateLimits: {
    kind: "ratelimit",
    target: "ratelimit",
    methods: { limit: { effect: "write", args: [{ key: "personal" }], result: { success: op } } },
  },
};

type DoClasses = {
  [D in DoNamespace]: {
    [M in DoMethod<D>]: { effect: Effect; args: ArgsTree<DoArgs<D, M>>; result: ClassTree<DoResult<D, M>> };
  };
};

const sv = { schema_version: op } as const;
const ping = () => ({ effect: "read" as const, args: [] as [], result: { ...sv, ok: op } as { schema_version: "operational"; ok: "operational" } });

/** Per RPC method of the schema's contract; a method added there does not compile until it is classified here. */
export const DO_CLASSES: DoClasses = {
  ScopeCoordinator: {
    ping: ping(),
    acquireLock: { effect: "write", args: [{ run_id: op, ttl_s: op }], result: { ...sv, acquired: op, holder_run_id: op } },
    releaseLock: { effect: "write", args: [{ run_id: op }], result: { ...sv, released: op } },
    insertVersion: {
      effect: "write",
      args: [{ run_id: op, pack: op, version: op }],
      result: { ...sv, promoted: op, already_promoted: op },
    },
    rebuildIndex: { effect: "write", args: [{ scope: op }], result: { ...sv, sha256: op, serial: op } },
  },
  Quota: {
    ping: ping(),
    consume: {
      effect: "write",
      args: [{ kind: op, principal: "personal", day: op, cap: op }],
      result: { ...sv, allowed: op, count: op, cap: op },
    },
    peek: { effect: "read", args: [{ kind: op, principal: "personal", day: op }], result: { ...sv, count: op } },
  },
  RootCoordinator: {
    ping: ping(),
    notifyScopeChange: { effect: "write", args: [{ scope: op, sha256: op, serial: op }], result: { ...sv, queued: op } },
  },
};

export const DURABLE_OBJECT_SPEC: DynamicPortSpec = {
  kind: "do",
  target: "do",
  method: "call",
  resolve: (args) => {
    const [namespace, , method] = args as [DoNamespace, string, string];
    const entry = (DO_CLASSES[namespace] as unknown as Record<string, unknown> | undefined)?.[method];
    if (!entry) throw new Error(`Durable Object method ${String(namespace)}.${method} has no recorder classification`);
    const e = entry as { effect: Effect; args: unknown; result: unknown };
    return {
      op: `${namespace}.${method}`,
      effect: e.effect,
      rules: {
        "request.args.0": op,
        "request.args.1": content,
        "request.args.2": op,
        ...treeRules(e.args, "request.args.3"),
        ...treeRules(e.result, "result"),
      },
    };
  },
};

/** Wraps every port so each call goes through the one Recorder; per-binding ports are keyed by binding name. */
export function instrumentAll(ports: Ports, recorder: Recorder): Ports {
  const wrapped: Record<string, unknown> = {};
  for (const name of Object.keys(PORT_SPECS) as Array<keyof typeof PORT_SPECS>) {
    wrapped[name] = instrument(ports[name] as object, PORT_SPECS[name] as PortSpec<object>, recorder);
  }
  wrapped.durableObjects = instrument(ports.durableObjects, DURABLE_OBJECT_SPEC, recorder);
  for (const name of Object.keys(BINDING_SPECS) as Array<keyof BindingPorts>) {
    wrapped[name] = Object.fromEntries(
      Object.entries(ports[name]).map(([binding, port]) => [
        binding,
        instrument(port as object, BINDING_SPECS[name] as PortSpec<object>, recorder, binding),
      ]),
    );
  }
  return wrapped as unknown as Ports;
}
