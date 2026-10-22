import { z } from "zod";
import { PackName, PackVersion, Sha256, Timestamp } from "./domain";

const oidcProvenance = z.object({
  source: z.literal("oidc"),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "owner/repo"),
  repository_id: z.number().int().positive(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  ref: z.string().min(1),
  event: z.string().min(1),
  workflow_run: z.string().min(1),
  path: z.string().min(1),
  source_verified: z.boolean(),
});

/** An upload carries no repository claims, so none can be asserted. */
const uploadProvenance = z.strictObject({
  source: z.literal("upload"),
  source_verified: z.literal(false),
});

export const Provenance = z.discriminatedUnion("source", [oidcProvenance, uploadProvenance]);
export type Provenance = z.infer<typeof Provenance>;

/** `.attestation.json`, signed by the registry key (the signature itself travels beside it). */
export const Attestation = z.object({
  pack: PackName,
  version: PackVersion,
  upload_sha256: Sha256,
  canonical_sha256: Sha256,
  provenance: Provenance,
  rules_version: z.string().min(1),
  validated_at: Timestamp,
  kid: z.string().min(1),
});
export type Attestation = z.infer<typeof Attestation>;
