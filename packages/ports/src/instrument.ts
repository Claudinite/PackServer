import type { InvocationKind } from "@packserver/schema";
import type { ClassRules } from "./classification";
import type { InvokeSpec, Recorder } from "./recorder";
import type { Ports } from "./ports";

type Effect = InvokeSpec["effect"];
type FunctionKeys<P> = { [K in keyof P]: P[K] extends (...args: never[]) => unknown ? K : never }[keyof P];

export interface MethodSpec {
  effect: Effect | ((args: unknown[]) => Effect);
  /** Named view of the arguments; the default is `{ args }`. */
  request?: (args: unknown[]) => unknown;
  result?: (result: unknown) => unknown;
  rules: ClassRules;
}

export interface PortSpec<P> {
  kind: InvocationKind;
  target: string;
  /** Exhaustive by type: a new port method does not compile until it is classified here. */
  methods: { [M in FunctionKeys<P>]: MethodSpec };
}

export function instrument<P extends object>(port: P, spec: PortSpec<P>, recorder: Recorder): P {
  const methods = spec.methods as Record<string, MethodSpec>;
  return new Proxy(port, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const m = methods[prop];
      if (!m) throw new Error(`port method ${spec.target}.${prop} has no recorder classification`);
      return (...args: unknown[]) =>
        recorder.invoke(
          {
            kind: spec.kind,
            target: spec.target,
            op: prop,
            effect: typeof m.effect === "function" ? m.effect(args) : m.effect,
            request: m.request ? m.request(args) : { args },
            rules: m.rules,
          },
          () => (value as (...a: unknown[]) => unknown).apply(target, args),
          m.result as ((r: unknown) => unknown) | undefined,
        );
    },
  });
}

const op = "operational";
const content = "customer-content";
const isRead = (sql: unknown) => (/^\s*(select|pragma|with)\b/i.test(String(sql)) ? "read" : "write");

export const PORT_SPECS: { [K in keyof Ports]: PortSpec<Ports[K]> } = {
  clock: { kind: "clock", target: "clock", methods: { now: { effect: "read", rules: { result: op } } } },
  rng: {
    kind: "random",
    target: "rng",
    methods: {
      float: { effect: "read", rules: { result: op } },
      uuid: { effect: "read", rules: { result: op } },
      bytes: { effect: "read", rules: { "request.args.0": op, result: "secret" } },
    },
  },
  github: {
    kind: "http",
    target: "api.github.com",
    methods: {
      getRepo: { effect: "read", rules: { "request.args.*": op, "result.**": op } },
      getRef: { effect: "read", rules: { "request.args.*": op, "result.**": op } },
      getTree: { effect: "read", rules: { "request.args.*": op, result: content } },
      getBlob: { effect: "read", rules: { "request.args.*": op, result: content } },
      getFile: { effect: "read", rules: { "request.args.*": op, result: content } },
      searchCode: { effect: "read", rules: { "request.args.*": op, "result.**": op } },
    },
  },
  oidc: {
    kind: "http",
    target: "token.actions.githubusercontent.com",
    methods: {
      verify: { effect: "read", rules: { "request.args.0": "secret", "request.args.1.audience": op, "result.**": op } },
    },
  },
  vectors: {
    kind: "vectorize",
    target: "vectors",
    methods: {
      upsert: {
        effect: "write",
        rules: { "request.args.0.*.id": op, "request.args.0.*.vector": content, "request.args.0.*.metadata.**": op },
      },
      query: { effect: "read", rules: { "request.args.0": content, "request.args.1.**": op, "result.**": op } },
      deleteByIds: { effect: "write", rules: { "request.args.0.*": op } },
    },
  },
  embedder: {
    kind: "service",
    target: "embedder",
    methods: { embed: { effect: "read", rules: { "request.args.0": content, result: content } } },
  },
  sandbox: {
    kind: "service",
    target: "sandbox",
    methods: {
      inspect: { effect: "read", rules: { "request.args.0.archive_key": op, "result.**": op, "result.findings.**": content } },
      run: {
        effect: "read",
        rules: {
          "request.args.0.canonical_key": op,
          "request.args.0.tree_hash": op,
          "result.**": op,
          "result.findings.**": content,
        },
      },
    },
  },
  proseScreen: {
    kind: "service",
    target: "prose-screen",
    methods: {
      screen: {
        effect: "read",
        rules: {
          "request.args.0.nonce": op,
          "request.args.0.chunks.*.id": op,
          "request.args.0.chunks.*.text": content,
          "result.**": op,
        },
      },
    },
  },
  mail: {
    kind: "http",
    target: "mail",
    methods: {
      send: {
        effect: "external_side_effect",
        rules: {
          "request.args.0.to": "personal",
          "request.args.0.subject": content,
          "request.args.0.text": content,
          "result.id": op,
        },
      },
    },
  },
  dns: {
    kind: "http",
    target: "dns-over-https",
    methods: { resolveTxt: { effect: "read", rules: { "request.args.0": op, "result.*": op } } },
  },
  turnstile: {
    kind: "http",
    target: "challenges.cloudflare.com",
    methods: {
      verify: { effect: "read", rules: { "request.args.0": "secret", "request.args.1": "personal", "result.**": op } },
    },
  },
  access: {
    kind: "http",
    target: "access",
    methods: { verify: { effect: "read", rules: { "request.args.0": "secret", "result.email": "personal", "result.sub": "personal" } } },
  },
  stats: {
    kind: "ae",
    target: "stats",
    methods: {
      write: {
        effect: "write",
        rules: { "request.args.0.name": op, "request.args.0.blobs.*": content, "request.args.0.doubles.*": op, "request.args.0.index": op },
      },
    },
  },
  cache: {
    kind: "http",
    target: "cache",
    methods: {
      get: { effect: "read", rules: { "request.args.0": op, "result.**": op, "result.body": content } },
      put: {
        effect: "write",
        rules: { "request.args.0": op, "request.args.1.status": op, "request.args.1.headers.**": op, "request.args.1.body": content },
      },
      purge: { effect: "write", rules: { "request.args.0": op, result: op } },
    },
  },
  uploads: {
    kind: "r2",
    target: "uploads",
    methods: {
      create: { effect: "write", rules: { "request.args.0.**": op, "result.url": "secret", "result.key": op, "result.expires_at": op } },
      stat: { effect: "read", rules: { "request.args.0": op, "result.**": op } },
      read: { effect: "read", rules: { "request.args.0": op, result: content } },
    },
  },
  audit: {
    kind: "r2",
    target: "audit",
    methods: {
      append: {
        effect: "write",
        rules: { "request.args.0": content, "result.seq": op, "result.prev_hash": op, "result.hash": op, "result.event": content },
      },
      head: { effect: "read", rules: { "result.**": op } },
    },
  },
  transparency: {
    kind: "http",
    target: "rekor",
    methods: { anchor: { effect: "external_side_effect", rules: { "request.args.0.**": op, "result.**": op } } },
  },
  d1: {
    kind: "d1",
    target: "d1",
    methods: {
      query: {
        effect: (args) => isRead(args[0]),
        request: (args) => ({ sql: args[0], params: args[1] ?? [] }),
        rules: { "request.sql": op, "request.tables.*": op, "request.params": content, "result.rows": content, "result.meta.**": op },
      },
      batch: {
        effect: (args) =>
          (args[0] as Array<{ sql: unknown }>).every((s) => isRead(s.sql) === "read") ? "read" : "write",
        request: (args) => {
          const statements = args[0] as Array<{ sql: unknown; params?: unknown[] }>;
          return { sql: statements.map((s) => String(s.sql)).join(";\n"), params: statements.map((s) => s.params ?? []) };
        },
        result: (r) => {
          const results = r as Array<{ rows: unknown[]; meta: { changes: number } }>;
          return { rows: results.flatMap((x) => x.rows), meta: { changes: results.reduce((n, x) => n + x.meta.changes, 0) } };
        },
        rules: { "request.sql": op, "request.tables.*": op, "request.params": content, "result.rows": content, "result.meta.**": op },
      },
    },
  },
  r2: {
    kind: "r2",
    target: "r2",
    methods: {
      get: { effect: "read", rules: { "request.args.0": op, result: content } },
      head: { effect: "read", rules: { "request.args.0": op, "result.**": op } },
      put: { effect: "write", rules: { "request.args.0": op, "request.args.1": content, "request.args.2.**": op } },
      delete: { effect: "write", rules: { "request.args.0": op } },
      list: { effect: "read", rules: { "request.args.0": op, "result.*": op } },
    },
  },
  kv: {
    kind: "kv",
    target: "kv",
    methods: {
      get: { effect: "read", rules: { "request.args.0": op, result: content } },
      put: { effect: "write", rules: { "request.args.0": op, "request.args.1": content, "request.args.2.**": op } },
      delete: { effect: "write", rules: { "request.args.0": op } },
      list: { effect: "read", rules: { "request.args.0": op, "result.*": op } },
    },
  },
  queue: {
    kind: "queue",
    target: "queue",
    methods: {
      send: { effect: "write", rules: { "request.args.0": content } },
      sendBatch: { effect: "write", rules: { "request.args.0": content } },
    },
  },
  durableObjects: {
    kind: "do",
    target: "do",
    methods: {
      call: { effect: "write", rules: { "request.args.0": op, "request.args.1": op, "request.args.2": op, "request.args.3": content, result: content } },
    },
  },
};

/** Wraps every port so each call goes through the one Recorder. */
export function instrumentAll(ports: Ports, recorder: Recorder): Ports {
  const wrapped = {} as Record<string, unknown>;
  for (const name of Object.keys(PORT_SPECS) as Array<keyof Ports>) {
    wrapped[name] = instrument(ports[name] as object, PORT_SPECS[name] as PortSpec<object>, recorder);
  }
  return wrapped as unknown as Ports;
}
