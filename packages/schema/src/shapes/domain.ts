import { z } from "zod";

export const VERSION_STATUSES = ["active", "deprecated", "yanked", "quarantined", "revoked", "removed"] as const;
export const VersionStatus = z.enum(VERSION_STATUSES);
export type VersionStatus = z.infer<typeof VersionStatus>;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");
export const Timestamp = z.iso.datetime();
export const PackName = z.string().regex(/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/, "@scope/name");
export const ScopeName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "scope without the @");
export const PackVersion = z.string().regex(/^\d+\.\d+\.\d+$/, "three-part version");
export const Serial = z.number().int().nonnegative();

/** Facts the validator establishes about who stands behind a version. */
export const VerificationFacts = z.object({
  verified: z.boolean(),
  verified_domain: z.string().nullable(),
  verified_github_org: z.string().nullable(),
  source_verified: z.boolean(),
});
export type VerificationFacts = z.infer<typeof VerificationFacts>;

export const CAPABILITY_KINDS = ["guard", "coded-check", "task", "env-setup", "forced-skill"] as const;
export const Capability = z.union([
  z.enum(CAPABILITY_KINDS),
  z.string().regex(/^github-action:.+$/, "github-action:<name>"),
]);
export type Capability = z.infer<typeof Capability>;

export const CapabilitySet = z
  .array(Capability)
  .refine((set) => new Set(set).size === set.length, "capabilities are unique");
export type CapabilitySet = z.infer<typeof CapabilitySet>;

export const PreInstallManifest = z.object({
  guards: z.array(z.object({ name: z.string().min(1), tool_calls: z.array(z.string()) })),
  tasks: z.array(
    z.object({
      name: z.string().min(1),
      cadence: z.string().min(1),
      opens_pr: z.boolean(),
      agentic_phase: z.boolean(),
    }),
  ),
  forced_skills: z.array(z.string()),
  github_actions: z.array(z.string()),
  /** Entries the previous promoted version lacked. */
  new: z.array(z.string()),
});
export type PreInstallManifest = z.infer<typeof PreInstallManifest>;

export const VERDICT_CLASSES = ["fail", "hold", "warn"] as const;
export const VerdictClass = z.enum(VERDICT_CLASSES);
export type VerdictClass = z.infer<typeof VerdictClass>;

export const Verdict = z.enum(["pass", "warn", "hold", "fail"]);
export type Verdict = z.infer<typeof Verdict>;

export const Finding = z.object({
  rule: z.string().min(1),
  class: VerdictClass,
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  quote: z.string().nullable(),
  hint: z.string(),
});
export type Finding = z.infer<typeof Finding>;
