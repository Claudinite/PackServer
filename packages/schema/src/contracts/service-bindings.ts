import { z } from "zod";
import {
  PackName,
  PackVersion,
  ScopeName,
  Serial,
  Sha256,
  Timestamp,
  Verdict,
} from "../shapes/domain";
import { ScoreBreakdown } from "../shapes/meta";
import { UnsignedPrivateEntry, UnsignedRoot, UnsignedScopeIndex } from "../shapes/index-v1";
import { Refusal } from "../shapes/refusals";

/** publish -> validator: start a validation run. */
export const StartValidationRequest = z.object({
  run_id: z.string().min(1),
  pack: PackName,
  version: PackVersion,
  staging_key: z.string().min(1),
  declared_sha256: Sha256,
  dry_run: z.boolean(),
  source: z.enum(["oidc", "upload"]),
  credential_id: z.string().min(1),
});
export const StartValidationResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), run_id: z.string().min(1), workflow_instance_id: z.string().min(1) }),
  z.object({ ok: z.literal(false), refusal: Refusal }),
]);

/** web -> mcp: site search. */
export const SearchRequest = z.object({
  query: z.string().min(1).max(500),
  category: z.string().optional(),
  part: z.string().optional(),
  has_repository: z.boolean().optional(),
  verified_only: z.boolean().optional(),
  verified_domains: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export const PackCard = z.object({
  id: PackName,
  pitch: z.string(),
  inventory_counts: z.record(z.string(), z.number().int().nonnegative()),
  context_cost: z.number().int().nonnegative(),
  verified: z.boolean(),
  verified_domain: z.string().nullable(),
  verified_github_org: z.string().nullable(),
  verdict: Verdict,
  repository: z.string().nullable(),
  rating: z.number().nullable(),
  score: z.number().int().min(0).max(100),
  score_parts: ScoreBreakdown.shape.parts,
  newest_eligible: z.object({ version: PackVersion, published_at: Timestamp, min_engine_version: PackVersion }).nullable(),
});
export const SearchResponse = z.object({
  cards: z.array(PackCard),
  degraded: z.boolean(),
});

/** web -> publish: wizard uploads. */
export const WizardUploadRequest = z.object({
  pack: PackName,
  version: PackVersion,
  action: z.enum(["upload-url", "start", "dry-run"]),
  declared_sha256: Sha256.optional(),
  principal_id: z.string().min(1),
});
export const WizardUploadResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    upload_url: z.url().optional(),
    expires_at: Timestamp.optional(),
    run_id: z.string().optional(),
  }),
  z.object({ ok: z.literal(false), refusal: Refusal }),
]);

/** validator -> github: fetch the repository tree for source verification (read only). */
export const TreeFetchRequest = z.object({
  repository_id: z.number().int().positive(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().min(1),
});
export const TreeFetchResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), tree_hash: Sha256, file_count: z.number().int().nonnegative() }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("unreachable"), retry_after_s: z.number().int().positive().optional() }),
]);

/** coordinator -> validator: the validator signs, writes to R2, and returns hash and serial. */
export const SignedDocumentAck = z.object({ sha256: Sha256, serial: Serial, key: z.string().min(1), kid: z.string().min(1) });
export const SignScopeIndexRequest = z
  .object({ scope: ScopeName, unsigned: UnsignedScopeIndex })
  .refine((r) => r.unsigned.scope === r.scope, { message: "the document's scope is the request's scope", path: ["unsigned", "scope"] });
export const SignScopeIndexResponse = SignedDocumentAck;
export const SignPrivateEntriesRequest = z
  .object({ scope: ScopeName, entries: z.array(UnsignedPrivateEntry) })
  .refine((r) => r.entries.every((e) => e.pack.startsWith(`@${r.scope}/`)), {
    message: "every private entry's pack belongs to the request's scope",
    path: ["entries"],
  });
export const SignPrivateEntriesResponse = z.object({ entries: z.array(SignedDocumentAck.extend({ pack: PackName })) });
export const SignAndWriteRootRequest = z.object({ unsigned: UnsignedRoot });
export const SignAndWriteRootResponse = SignedDocumentAck;

export const VALIDATOR_ENTRYPOINT_METHODS = ["signScopeIndex", "signPrivateEntries", "signAndWriteRoot"] as const;
