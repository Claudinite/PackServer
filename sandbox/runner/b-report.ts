import { z } from "zod";
import { Sha256 } from "@packserver/schema";
import { B_LIMITS } from "./b-limits.ts";

/** Why a run is an infrastructure error. Never pack content. */
export const B_ERRORS = [
  "input_invalid",
  "extract_failed",
  "tree_hash_mismatch",
  "engine_digest_mismatch",
  "engine_unpack_failed",
  "sdk_missing",
  "isolation_unavailable",
  "worker_start_timeout",
  "crashed",
  "out_of_memory",
  "report_invalid",
  "report_over_cap",
] as const;

/** Text that came from a tool run over pack content: bounded and stripped of control characters. */
export const Text = z.string().max(B_LIMITS.messageChars);
/** A path inside the pack, or null when the tool named none that is safe to echo. */
export const PackPath = z.string().regex(/^[A-Za-z0-9._@/-]{1,200}$/).nullable();

const Load = z.strictObject({
  /** `skipped` when no pack code was allowed to start (unsupported engine) or the earlier steps already failed. */
  status: z.enum(["loaded", "failed", "timeout", "skipped"]),
  exit_code: z.number().int().nullable(),
  file: PackPath,
  message: Text.nullable(),
});

/**
 * What sandbox B returns: facts about the run, never a verdict. The registry parses it with this
 * schema and treats a parse failure as an infrastructure error; the verdict fields (`outcome`,
 * `error`, `tree`) come from the runner, the rest from tools run over the pack.
 */
export const SandboxBReport = z.strictObject({
  schema: z.literal(1),
  /**
   * `ok`: every step ran to its end; `refused`: the decoder timed out, crashed or ran out of memory
   * on the archive (REQ-VAL-045, final, as in sandbox A); `timeout`: the 5 minute run overran;
   * `error`: infrastructure.
   */
  outcome: z.enum(["ok", "refused", "timeout", "error"]),
  refusal: z.strictObject({ reason: z.enum(["archive.bomb", "archive.unsafe"]), code: z.string().max(40) }).nullable(),
  error: z.enum(B_ERRORS).nullable(),
  image_digest: z.string().nullable(),
  /** True once any pack content was compiled, loaded or run. REQ-VAL-051: false whenever the tree hash differed. */
  pack_code_executed: z.boolean(),
  tree: z.strictObject({ expected: Sha256, found: Sha256.nullable(), matches: z.boolean() }),
  /** `supported` is false when `declared` is older than the mirror's oldest release: engine.unsupported_min_version. */
  min_engine: z.strictObject({ declared: z.string(), oldest_in_mirror: z.string(), supported: z.boolean() }),
  engines: z.array(z.strictObject({ role: z.enum(["newest", "lowest"]), version: z.string(), digest_verified: z.boolean(), load: Load })),
  compile: z.array(z.strictObject({ file: PackPath, status: z.enum(["compiled", "failed", "timeout", "skipped"]), message: Text.nullable() })),
  declared: z.array(z.strictObject({ file: PackPath, status: z.enum(["parsed", "failed"]), message: Text.nullable() })),
  runs: z.array(
    z.strictObject({
      kind: z.enum(["task_worker", "env_setup"]),
      name: PackPath,
      status: z.enum(["ran", "skipped"]),
      run_count: z.number().int().min(0).max(1),
      exit_status: z.number().int().nullable(),
      signal: z.string().max(16).nullable(),
      timed_out: z.boolean(),
      egress_count: z.number().int().nonnegative(),
    }),
  ),
  egress: z.array(z.strictObject({ run: PackPath, kind: z.enum(["connect", "dns", "udp", "fetch"]), target: z.string().max(200) })),
  egress_total: z.number().int().nonnegative(),
  egress_truncated: z.boolean(),
  inventory: z.array(
    z.strictObject({
      path: z.string().max(4096),
      kind: z.enum(["manifest", "rules", "skill", "check", "declared_check", "task", "worker", "doc", "other"]),
      bytes: z.number().int().nonnegative(),
      /** An estimate for prose files; null where tokens are not meaningful. */
      tokens: z.number().int().nonnegative().nullable(),
    }),
  ),
  inventory_total: z.number().int().nonnegative(),
  inventory_truncated: z.boolean(),
  token_counts: z.strictObject({ total: z.number().int().nonnegative(), method: z.literal("bytes/4") }).nullable(),
  timings_ms: z.strictObject({ extract: z.number().int().nonnegative().nullable(), total: z.number().int().nonnegative() }),
});
export type SandboxBReport = z.infer<typeof SandboxBReport>;

export interface BReportBase {
  imageDigest: string | null;
  expectedTreeHash: string;
  minEngineVersion: string;
  oldestInMirror: string;
}

export function emptyBReport(base: BReportBase): SandboxBReport {
  return {
    schema: 1,
    outcome: "error",
    refusal: null,
    error: null,
    image_digest: base.imageDigest,
    pack_code_executed: false,
    tree: { expected: base.expectedTreeHash, found: null, matches: false },
    min_engine: { declared: base.minEngineVersion, oldest_in_mirror: base.oldestInMirror, supported: true },
    engines: [],
    compile: [],
    declared: [],
    runs: [],
    egress: [],
    egress_total: 0,
    egress_truncated: false,
    inventory: [],
    inventory_total: 0,
    inventory_truncated: false,
    token_counts: null,
    timings_ms: { extract: null, total: 0 },
  };
}

export function bErrorReport(base: BReportBase, error: (typeof B_ERRORS)[number], timings: SandboxBReport["timings_ms"], outcome: "error" | "timeout" = "error"): SandboxBReport {
  return { ...emptyBReport(base), outcome, error, timings_ms: timings };
}

export function bRefusedReport(base: BReportBase, reason: "archive.bomb" | "archive.unsafe", code: string, timings: SandboxBReport["timings_ms"]): SandboxBReport {
  return { ...emptyBReport(base), outcome: "refused", refusal: { reason, code }, timings_ms: timings };
}

/** Free text of tool output: no control or invisible format characters, bounded. */
export function clean(text: string): string {
  // Control characters (C0, DEL, C1), format characters (bidi marks and overrides, zero-width, BOM) and line and paragraph separators go; newline and tab stay.
  return text.replace(/(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, B_LIMITS.messageChars);
}

/** Trims a report to the cap by shedding the lists that grow; null when it still does not fit. */
export function fitToBCap(report: SandboxBReport): SandboxBReport | null {
  const fits = (r: SandboxBReport) => Buffer.byteLength(JSON.stringify(r)) <= B_LIMITS.reportBytes;
  if (fits(report)) return report;
  const trimmed: SandboxBReport = { ...report, inventory: report.inventory.slice(0, 100), inventory_truncated: true };
  if (fits(trimmed)) return trimmed;
  const bare: SandboxBReport = { ...trimmed, inventory: [], egress: trimmed.egress.slice(0, 20), egress_truncated: trimmed.egress_total > 20 };
  return fits(bare) ? bare : null;
}
