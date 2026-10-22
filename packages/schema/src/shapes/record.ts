import { z } from "zod";
import { Timestamp } from "./domain";

export const RECORDER_MODES = ["off", "wet"] as const;
export const RecorderMode = z.enum(RECORDER_MODES);
export type RecorderMode = z.infer<typeof RecorderMode>;

export const INVOCATION_KINDS = [
  "d1", "r2", "kv", "do", "vectorize", "queue", "ae", "workflow", "ratelimit", "http", "service", "clock", "random",
] as const;
export const InvocationKind = z.enum(INVOCATION_KINDS);
export type InvocationKind = z.infer<typeof InvocationKind>;

export const INVOCATION_EFFECTS = ["read", "write", "external_side_effect"] as const;

/** Allowlisted headers only; everything else is dropped before recording and never hashed. */
export const REQUEST_HEADER_ALLOWLIST = [
  "content-type", "accept", "accept-encoding", "user-agent", "x-packserver-client", "idempotency-key",
] as const;
export const RESPONSE_HEADER_ALLOWLIST = [
  "content-type", "cache-control", "etag", "location", "www-authenticate", "x-packserver-version", "retry-after",
] as const;

export const VOLATILE_PLACEHOLDERS = ["<ts>", "<uuid:n>", "<sig>", "<session>", "<opaque>", "<rowid>"] as const;

export const BODY_CAP_BYTES = 8 * 1024;
export const INVOCATION_BODY_CAP_BYTES = 4 * 1024;
export const D1_ROW_CAP = 50;
export const FLOAT_SIGNIFICANT_DIGITS = 6;

const hash = z.string().min(1);
const requestHeaders = z.partialRecord(z.enum(REQUEST_HEADER_ALLOWLIST), z.string());
const responseHeaders = z.partialRecord(z.enum(RESPONSE_HEADER_ALLOWLIST), z.string());
const json = z.unknown();

const errorRecord = z.object({ name: z.string(), message: z.string(), stack_hash: hash });

export const Invocation = z.object({
  seq: z.number().int().nonnegative(),
  parent: z.number().int().nonnegative().nullable(),
  kind: InvocationKind,
  target: z.string().min(1),
  op: z.string().min(1),
  effect: z.enum(INVOCATION_EFFECTS),
  request: json,
  request_hash: hash,
  /** Bodies over 4 KB and D1 rows over 50 are hashed only, so `result` may be absent. */
  result: json.optional(),
  result_hash: hash,
  row_count: z.number().int().nonnegative().optional(),
  unordered: z.boolean().optional(),
  ms: z.number().nonnegative(),
  executed: z.boolean(),
  error: z.object({ name: z.string(), message_hash: hash }).nullable(),
  /** Dry-side fields: null in wet mode. */
  match: z.string().nullable(),
  overlay: z.string().nullable(),
  stub: z.string().nullable(),
});
export type Invocation = z.infer<typeof Invocation>;

export const RecordEnvelope = z
  .object({
    v: z.literal(1),
    request_id: z.string().min(1),
    side: z.string().min(1),
    worker: z.string().min(1),
    version_id: z.string().min(1),
    release_id: z.string().min(1),
    mode: RecorderMode,
    ts: Timestamp,
    request: z.object({
      method: z.string().min(1),
      route: z.string().min(1),
      path_params: z.record(z.string(), z.string()),
      query: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      headers: requestHeaders,
      principal: z.object({ kind: z.string().min(1), id_hash: hash }).nullable(),
      body_hash: hash.nullable(),
      body: json.optional(),
    }),
    response: z.object({
      status: z.number().int().min(100).max(599),
      headers: responseHeaders,
      body_hash: hash.nullable(),
      body: json.optional(),
      ms: z.number().nonnegative(),
      error: errorRecord.nullable(),
    }),
    pins: z.object({
      now: Timestamp,
      now_deltas: z.array(z.number()),
      random: z.array(z.number()),
      d1_bookmark: z.string().nullable(),
    }),
    invocations: z.array(Invocation),
    outcome: z.string().min(1),
    truncated: z.boolean(),
    /** Paths removed by classification (REQ-OPS-012). */
    redactions: z.array(z.string()),
  })
  .refine((e) => e.invocations.every((inv, i) => i === 0 || inv.seq > (e.invocations[i - 1]?.seq ?? 0)), {
    message: "invocations are in seq order",
    path: ["invocations"],
  })
  .refine((e) => e.mode !== "wet" || e.invocations.every((i) => i.match === null && i.overlay === null && i.stub === null), {
    message: "dry-side fields are null in wet mode",
    path: ["invocations"],
  });
export type RecordEnvelope = z.infer<typeof RecordEnvelope>;
