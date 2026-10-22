import {
  BODY_CAP_BYTES,
  D1_ROW_CAP,
  INVOCATION_BODY_CAP_BYTES,
  RecordEnvelope,
  type Invocation,
  type InvocationKind,
  type RecorderMode,
} from "@packserver/schema";
import { BASE_RULES, assertNoCatchAllGrant, redact, type ClassRules } from "./classification";
import { hmacHex, principalHash, sha256Hex, type HashKey } from "./hash";
import {
  Normalizer,
  canonicalJson,
  normalizeSql,
  requestHeaders,
  responseHeaders,
  sortUnorderedRows,
} from "./normalize";
import type { Clock } from "./ports";

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
const dotSafe = (s: string) => s.replace(/\./g, "_");

export type RecordSink = (line: string) => void | Promise<void>;

export interface RecorderContext {
  request_id: string;
  side: string;
  worker: string;
  version_id: string;
  release_id: string;
}

export interface RecorderOptions {
  mode: RecorderMode;
  context: RecorderContext;
  /** The raw clock: the Recorder must not record its own reads. */
  clock: Clock;
  sink?: RecordSink;
  /** Keys for placeholders and principal hashes; required in `wet`. */
  keys?: { redaction: HashKey; principal: HashKey };
  /** Classification rules added to the base table. */
  rules?: ClassRules;
}

export interface InvokeSpec {
  kind: InvocationKind;
  target: string;
  op: string;
  effect: Invocation["effect"];
  /** For `d1` an object with `sql` and optional `params`. */
  request: unknown;
  /** Paths relative to `inv.<target>.<op>.`, e.g. `request.params`. */
  rules?: ClassRules;
  parent?: number | null;
}

export interface FinishInput {
  request: {
    method: string;
    route: string;
    pathParams?: Record<string, string>;
    query?: URLSearchParams | Record<string, string | string[]>;
    headers: Headers | Record<string, string>;
    principal: { kind: string; id: string } | null;
    /** Parsed JSON body. */
    body?: unknown;
    /** Any other body: only a keyed hash is kept. */
    rawBody?: Uint8Array | string;
  };
  response: {
    status: number;
    headers: Headers | Record<string, string>;
    body?: unknown;
    rawBody?: Uint8Array | string;
    ms: number;
    error?: Error | null;
  };
  outcome: string;
  d1Bookmark?: string | null;
}

/** Only the `at …` frames: the message line of a stack can carry a person's data. */
function stackFrames(error: Error): string {
  const frames = (error.stack ?? "").split("\n").filter((l) => /^\s+at\s/.test(l));
  return frames.length ? frames.join("\n") : error.name;
}

function sortedQuery(q: FinishInput["request"]["query"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!q) return out;
  if (q instanceof URLSearchParams) {
    for (const k of [...new Set(q.keys())].sort()) {
      const all = q.getAll(k);
      out[k] = all.length === 1 ? (all[0] as string) : all;
    }
    return out;
  }
  for (const k of Object.keys(q).sort()) out[k] = q[k] as string | string[];
  return out;
}

export interface Recorder {
  readonly mode: RecorderMode;
  /** Sync calls stay sync: a promise from `fn` is awaited, anything else is returned as is. */
  invoke<T>(spec: InvokeSpec, fn: () => T, mapResult?: (result: Awaited<T>) => unknown): T;
  /** The envelope, also written to the sink as one JSON line; `null` in `off`. */
  finish(input: FinishInput): Promise<RecordEnvelope | null>;
  /** Concrete paths of recorded values no rule reached (they were stored as customer-content). */
  unclassifiedPaths(): string[];
}

export function createRecorder(options: RecorderOptions): Recorder {
  const mode = options.mode as string;
  if (mode !== "off" && mode !== "wet") {
    throw new Error(`recorder mode "${mode}" is reserved and not implemented`);
  }
  if (mode === "off") {
    return {
      mode: "off",
      invoke: (_spec, fn) => fn(),
      finish: async () => null,
      unclassifiedPaths: () => [],
    };
  }
  if (!options.keys) throw new Error("a wet recorder needs redaction and principal keys");
  const keys = options.keys;
  assertNoCatchAllGrant(options.rules ?? {});
  const rules: ClassRules = { ...BASE_RULES, ...options.rules };
  const startMs = options.clock.now();
  const normalizer = new Normalizer(startMs);
  const redactions = new Set<string>();
  const unclassified = new Set<string>();
  const invocations: Invocation[] = [];
  let queue: Promise<void> = Promise.resolve();
  const nowDeltas: number[] = [];
  const randoms: number[] = [];
  let seq = 0;
  let lastNow = startMs;
  let truncated = false;
  let recordFailure: unknown;

  const clean = async (value: unknown, path: string, extra?: ClassRules): Promise<unknown> => {
    const r = await redact(value, path, extra ? { ...rules, ...extra } : rules, keys.redaction);
    r.redactions.forEach((p) => redactions.add(p));
    r.unclassified.forEach((p) => unclassified.add(p));
    return normalizer.value(r.value);
  };

  const prefixed = (prefix: string, rel?: ClassRules): ClassRules | undefined =>
    rel && Object.fromEntries(Object.entries(rel).map(([k, v]) => [`${prefix}.${k}`, v]));

  const record = async (
    spec: InvokeSpec,
    index: number,
    outcome: { result: unknown; error: Error | null },
    ms: number,
  ): Promise<void> => {
    const prefix = `inv.${dotSafe(spec.target)}.${dotSafe(spec.op)}`;
    const extra = prefixed(prefix, spec.rules);
    let request = spec.request;
    let ordered = true;
    if (spec.kind === "d1") {
      const r = (request ?? {}) as { sql?: unknown; params?: unknown };
      const n = normalizeSql(String(r.sql ?? ""));
      ordered = n.ordered;
      request = { sql: n.sql, params: r.params ?? [], tables: n.tables };
    }
    const requestNorm = await clean(request, `${prefix}.request`, extra);
    let resultNorm = await clean(outcome.result, `${prefix}.result`, extra);
    let rowCount: number | undefined;
    let unordered: boolean | undefined;
    if (spec.kind === "d1" && resultNorm && typeof resultNorm === "object") {
      const batch = Array.isArray(resultNorm);
      const sets = (batch ? resultNorm : [resultNorm]) as Array<{ rows?: unknown[] }>;
      if (sets.every((r) => Array.isArray(r?.rows))) {
        rowCount = sets.reduce((n, r) => n + (r.rows as unknown[]).length, 0);
        if (!ordered) {
          unordered = true;
          const sorted = sets.map((r) => ({ ...r, rows: sortUnorderedRows(r.rows as unknown[]) }));
          resultNorm = batch ? sorted : sorted[0];
        }
      }
    }
    const resultJson = canonicalJson(resultNorm);
    const requestJson = canonicalJson(requestNorm);
    const tooBig = byteLength(resultJson) > INVOCATION_BODY_CAP_BYTES || (rowCount !== undefined && rowCount > D1_ROW_CAP);
    const requestTooBig = byteLength(requestJson) > INVOCATION_BODY_CAP_BYTES;
    if (tooBig || requestTooBig) truncated = true;
    const entry: Invocation = {
      seq: index,
      parent: spec.parent ?? null,
      kind: spec.kind,
      target: spec.target,
      op: spec.op,
      effect: spec.effect,
      request: requestTooBig ? null : requestNorm,
      request_hash: await sha256Hex(requestJson),
      ...(tooBig ? {} : { result: resultNorm }),
      result_hash: await sha256Hex(resultJson),
      ...(rowCount !== undefined ? { row_count: rowCount } : {}),
      ...(unordered ? { unordered } : {}),
      ms,
      executed: true,
      error: outcome.error
        ? { name: outcome.error.name, message_hash: await hmacHex(keys.redaction, outcome.error.message) }
        : null,
      match: null,
      overlay: null,
      stub: null,
    };
    invocations.push(entry);
  };

  const body = async (path: string, parsed: unknown, raw: Uint8Array | string | undefined) => {
    if (parsed !== undefined) {
      const norm = await clean(parsed, path);
      const json = canonicalJson(norm);
      const big = byteLength(json) > BODY_CAP_BYTES;
      if (big) truncated = true;
      return { body_hash: await sha256Hex(json), ...(big ? {} : { body: norm }) };
    }
    if (raw !== undefined) return { body_hash: await hmacHex(keys.redaction, raw) };
    return { body_hash: null };
  };

  return {
    mode: "wet",

    invoke<T>(spec: InvokeSpec, fn: () => T, mapResult?: (result: Awaited<T>) => unknown): T {
      const index = seq++;
      const t0 = options.clock.now();
      const settle = (result: unknown, error: Error | null) => {
        const ms = Math.max(0, options.clock.now() - t0);
        // Pins are taken here, in call order; the async record below finishes in any order.
        if (!error && spec.kind === "clock" && typeof result === "number") {
          nowDeltas.push(result - lastNow);
          lastNow = result;
        }
        if (!error && spec.kind === "random" && typeof result === "number") randoms.push(result);
        const logged = mapResult && !error ? mapResult(result as Awaited<T>) : result;
        // Records run one after another so `<uuid:n>` numbering follows call order.
        queue = queue.then(() => record(spec, index, { result: logged, error }, ms)).catch((e: unknown) => {
          recordFailure ??= e;
        });
      };
      const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
      let out: T;
      try {
        out = fn();
      } catch (e) {
        settle(undefined, asError(e));
        throw e;
      }
      if (out instanceof Promise) {
        return out.then(
          (r: unknown) => {
            settle(r, null);
            return r;
          },
          (e: unknown) => {
            settle(undefined, asError(e));
            throw e;
          },
        ) as T;
      }
      settle(out, null);
      return out;
    },

    async finish(input) {
      await queue;
      if (recordFailure !== undefined) throw recordFailure;
      invocations.sort((a, b) => a.seq - b.seq);
      const req = input.request;
      const res = input.response;
      const query = (await clean(sortedQuery(req.query), "request.query")) as Record<string, string | string[]>;
      const pathParams = (await clean(req.pathParams ?? {}, "request.path_params")) as Record<string, string>;
      const reqHeaders = requestHeaders(req.headers);
      const resHeaders = responseHeaders(res.headers);
      const error = res.error
        ? {
            name: res.error.name,
            message: String(await clean(res.error.message, "response.error.message")),
            stack_hash: await hmacHex(keys.redaction, stackFrames(res.error)),
          }
        : null;
      const envelope = RecordEnvelope.parse({
        v: 1,
        ...options.context,
        mode: "wet",
        ts: new Date(startMs).toISOString(),
        request: {
          method: req.method,
          route: req.route,
          path_params: pathParams,
          query,
          headers: reqHeaders,
          principal: req.principal
            ? { kind: req.principal.kind, id_hash: await principalHash(keys.principal, req.principal.kind, req.principal.id) }
            : null,
          ...(await body("request.body", req.body, req.rawBody)),
        },
        response: {
          status: res.status,
          headers: resHeaders,
          ...(await body("response.body", res.body, res.rawBody)),
          ms: res.ms,
          error,
        },
        pins: {
          now: new Date(startMs).toISOString(),
          now_deltas: nowDeltas,
          random: randoms,
          d1_bookmark: input.d1Bookmark ?? null,
        },
        invocations,
        outcome: input.outcome,
        truncated,
        redactions: [...redactions].sort(),
      });
      await options.sink?.(JSON.stringify(envelope));
      return envelope;
    },

    unclassifiedPaths: () => [...unclassified].sort(),
  };
}
