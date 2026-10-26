import { z } from "zod";
import { Finding, Sha256 } from "@packserver/schema";
import { ScoreInputs } from "../../score/inputs.ts";

/**
 * What the two sandbox containers return and are handed. The registry wrote nothing into a report:
 * the container's output is untrusted, so the Worker parses it with these schemas and treats a
 * parse failure as an infrastructure error. The runner in `sandbox/` produces the same shapes.
 */

export const INSPECTOR_STATUSES = ["ran", "skipped"] as const;

/** Everything the Worker knows that container A cannot look up: D1 answers, snapshotted per run. */
export const SandboxARequest = z.strictObject({
  pack: z.string(),
  newest_version: z.string().nullable(),
  rules_version: z.string(),
  lookups: z.strictObject({
    popular_packs: z.array(z.string()),
    verified_scopes: z.array(z.string()),
    proven_domain_labels: z.array(z.strictObject({ label: z.string(), scope: z.string() })),
    /** Packs the publishing principal may read; any other name answers unreadable. */
    readable_packs: z.array(z.string()),
  }),
  previous_capabilities: z.unknown(),
});
export type SandboxARequest = z.infer<typeof SandboxARequest>;

export const SandboxAReport = z.strictObject({
  schema: z.literal(1),
  /** `refused` is a final archive verdict, `timeout` a run overrun, `error` an infrastructure failure. */
  outcome: z.enum(["ok", "refused", "timeout", "error"]),
  image_digest: z.string().nullable(),
  rules_version: z.string().min(1),
  /** REQ-VAL-051: this container never loads, compiles or runs pack content. */
  pack_code_executed: z.literal(false),
  refusal: z.strictObject({ reason: z.enum(["archive.bomb", "archive.unsafe"]), code: z.string() }).nullable(),
  tree_hash: Sha256.nullable(),
  canonical_sha256: Sha256.nullable(),
  canonical_bytes: z.number().int().nonnegative().nullable(),
  file_count: z.number().int().nonnegative().nullable(),
  round_trip_ok: z.boolean().nullable(),
  /**
   * Contract for consumers: `findings` is complete only when `findings_truncated` is false. When it
   * is true, `findings` is a prefix (possibly empty) of `findings_total` findings, so an empty list
   * with `findings_truncated` true is never a clean pass and must be treated as unverified.
   */
  findings: z.array(Finding),
  findings_total: z.number().int().nonnegative(),
  findings_truncated: z.boolean(),
  manifest: z.record(z.string(), z.unknown()).nullable(),
  urls: z.array(z.record(z.string(), z.unknown())),
  capabilities: z.unknown().nullable(),
  /** What the score reads of the tree; null when the report had to shed it to fit. */
  score_inputs: ScoreInputs.nullable(),
  inspectors: z.array(z.strictObject({ name: z.string(), status: z.enum(INSPECTOR_STATUSES), note: z.string().nullable() })),
  timings_ms: z.strictObject({ extract: z.number().int().nonnegative().nullable(), total: z.number().int().nonnegative() }),
  /** Short cause for `error`; never pack content. */
  error: z.string().nullable(),
});
export type SandboxAReport = z.infer<typeof SandboxAReport>;

const Version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

/**
 * `request.json` of container B: everything the Worker hands in besides the archive and the
 * releases. It names the pack, the tree hash container A committed, the pack's `minEngineVersion`,
 * the mirror's oldest release, and for each engine its version, the digest the registry pinned
 * and the tarball's file name under `cn/`.
 */
export const SandboxBRequest = z.strictObject({
  pack: z.string().regex(/^@[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/),
  expected_tree_hash: Sha256,
  min_engine_version: Version,
  oldest_engine_in_mirror: Version,
  engines: z
    .array(z.strictObject({ role: z.enum(["newest", "lowest"]), version: Version, sha256: Sha256, file: z.string().regex(/^[A-Za-z0-9._-]{1,100}\.tgz$/) }))
    .min(1)
    .max(2)
    .refine((es) => es.filter((e) => e.role === "newest").length === 1 && new Set(es.map((e) => e.role)).size === es.length, "exactly one newest engine, at most one lowest"),
});
export type SandboxBRequest = z.infer<typeof SandboxBRequest>;

/** Why a run of container B is an infrastructure error. Never pack content. */
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

export const B_MESSAGE_CHARS = 500;

/** Text that came from a tool run over pack content: bounded and stripped of control characters. */
export const BText = z.string().max(B_MESSAGE_CHARS);
/** A path inside the pack, or null when the tool named none that is safe to echo. */
export const PackPath = z.string().regex(/^[A-Za-z0-9._@/-]{1,200}$/).nullable();

const Load = z.strictObject({
  /** `skipped` when no pack code was allowed to start (unsupported engine) or the earlier steps already failed. */
  status: z.enum(["loaded", "failed", "timeout", "skipped"]),
  exit_code: z.number().int().nullable(),
  file: PackPath,
  message: BText.nullable(),
});

/**
 * What sandbox B returns: facts about the run, never a verdict. The verdict fields (`outcome`,
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
  compile: z.array(z.strictObject({ file: PackPath, status: z.enum(["compiled", "failed", "timeout", "skipped"]), message: BText.nullable() })),
  declared: z.array(z.strictObject({ file: PackPath, status: z.enum(["parsed", "failed"]), message: BText.nullable() })),
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
