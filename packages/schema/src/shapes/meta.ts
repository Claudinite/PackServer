import { z } from "zod";
import { CapabilitySet, PackName, PackVersion, PreInstallManifest, VerificationFacts } from "./domain";
import { Provenance } from "./attestation";

export const INVENTORY_PARTS = [
  "skills",
  "rules",
  "checks",
  "guards",
  "tasks",
  "env-setup",
  "forced-skills",
  "github-actions",
] as const;

export const InventoryPart = z.object({
  count: z.number().int().nonnegative(),
  names: z.array(z.string()),
  tokens: z.number().int().nonnegative().nullable(),
});

export const UrlInventoryEntry = z.object({
  url: z.string().min(1),
  domain: z.string().min(1),
  classification: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().nullable(),
});

export const ScoreRule = z.object({ rule: z.string().min(1), points: z.number(), max: z.number() });

export const ScoreBreakdown = z.object({
  total: z.number().int().min(0).max(100),
  parts: z.array(z.object({ part: z.string().min(1), weight: z.number(), points: z.number(), rules: z.array(ScoreRule) })),
  cap: z.object({ reason: z.string().min(1), max: z.number().int().min(0).max(100) }).nullable(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

/** `meta.json` beside each archive on the CDN. */
export const Meta = z.object({
  pack: PackName,
  version: PackVersion,
  inventory: z.object(Object.fromEntries(INVENTORY_PARTS.map((p) => [p, InventoryPart])) as Record<(typeof INVENTORY_PARTS)[number], typeof InventoryPart>),
  capabilities: CapabilitySet,
  preinstall: PreInstallManifest,
  url_inventory: z.array(UrlInventoryEntry),
  score: ScoreBreakdown,
  rules_version: z.string().min(1),
  verification: VerificationFacts,
  provenance: Provenance,
  diff_summary: z.object({
    previous_version: PackVersion.nullable(),
    files_added: z.number().int().nonnegative(),
    files_removed: z.number().int().nonnegative(),
    files_changed: z.number().int().nonnegative(),
    new_capabilities: CapabilitySet,
  }),
});
export type Meta = z.infer<typeof Meta>;
