import { z } from "zod";
import {
  PackName,
  PackVersion,
  PreInstallManifest,
  ScopeName,
  Serial,
  Sha256,
  Timestamp,
  VerificationFacts,
  VersionStatus,
} from "./domain";

export const SIGNED_DOCUMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const signature = { kid: z.string().min(1), signature: z.string().min(1) };

const hasStandardExpiry = (doc: { generated_at: string; expires: string }) =>
  Date.parse(doc.expires) - Date.parse(doc.generated_at) === SIGNED_DOCUMENT_TTL_MS;
const expiryIssue = { message: "expires is generated_at + 7 days", path: ["expires"] };

const documentHead = { serial: Serial, generated_at: Timestamp, expires: Timestamp };

/** Fields shared by a public index entry and a private entry. */
const versionFields = {
  version: PackVersion,
  sha256: Sha256,
  size: z.number().int().nonnegative(),
  published_at: Timestamp,
  status: VersionStatus,
  reason: z.string().min(1).optional(),
  security: z.string().min(1).optional(),
  min_engine_version: PackVersion,
  requires: z.array(z.string()),
  source_commit: z.string().nullable(),
  preinstall: PreInstallManifest,
};

type StatusFields = { status: VersionStatus; reason?: string | undefined; security?: string | undefined };

function checkStatusFields(v: StatusFields, ctx: z.RefinementCtx) {
  if (v.status !== "active" && v.reason === undefined) {
    ctx.addIssue({ code: "custom", message: "reason is required for any status but active", path: ["reason"] });
  }
  if (v.status === "revoked" && v.security === undefined) {
    ctx.addIssue({ code: "custom", message: "security is required for revoked", path: ["security"] });
  }
}

const indexVersionBase = z.object({ ...versionFields, ...VerificationFacts.shape });

export const IndexVersion = indexVersionBase.superRefine(checkStatusFields);
export type IndexVersion = z.infer<typeof IndexVersion>;

const INELIGIBLE_FOR_LATEST: readonly VersionStatus[] = ["yanked", "quarantined", "removed"];

export const IndexPack = z
  .object({
    name: PackName,
    latest_eligible: PackVersion.nullable(),
    status: z.literal("removed").optional(),
    versions: z.array(IndexVersion),
  })
  .refine(
    (p) => {
      if (p.latest_eligible === null) return true;
      const listed = p.versions.find((v) => v.version === p.latest_eligible);
      return listed !== undefined && !INELIGIBLE_FOR_LATEST.includes(listed.status);
    },
    { message: "latest_eligible names a listed version that is not yanked, quarantined or removed", path: ["latest_eligible"] },
  );
export type IndexPack = z.infer<typeof IndexPack>;

export const ROOT_KIND = "root";

const rootBody = z.strictObject({
  kind: z.literal(ROOT_KIND),
  ...documentHead,
  scopes: z.array(z.object({ scope: ScopeName, sha256: Sha256, serial: Serial })),
});
export const UnsignedRoot = rootBody.refine(hasStandardExpiry, expiryIssue);
export const RootIndex = rootBody.extend(signature).refine(hasStandardExpiry, expiryIssue);
export type RootIndex = z.infer<typeof RootIndex>;

const scopeBody = z.strictObject({
  kind: z.literal("scope"),
  scope: ScopeName,
  ...documentHead,
  packs: z.array(IndexPack),
});
export const UnsignedScopeIndex = scopeBody.refine(hasStandardExpiry, expiryIssue);
export const ScopeIndex = scopeBody.extend(signature).refine(hasStandardExpiry, expiryIssue);
export type ScopeIndex = z.infer<typeof ScopeIndex>;

const privateEntryBody = z.strictObject({
  kind: z.literal("private"),
  pack: PackName,
  ...documentHead,
  versions: z.array(indexVersionBase.extend({ version_id: z.string().min(1) }).superRefine(checkStatusFields)),
});
export const UnsignedPrivateEntry = privateEntryBody.refine(hasStandardExpiry, expiryIssue);
export const PrivateEntry = privateEntryBody.extend(signature).refine(hasStandardExpiry, expiryIssue);
export type PrivateEntry = z.infer<typeof PrivateEntry>;

/** The unsigned, non-storable wrapper `GET /api/private/index` returns; it signs nothing. */
export const PrivateIndexEnvelope = z.object({
  private: z.literal(true),
  storable: z.literal(false),
  entries: z.array(PrivateEntry),
});
export type PrivateIndexEnvelope = z.infer<typeof PrivateIndexEnvelope>;

export const KEY_STATUSES = ["active", "standby", "revoked"] as const;
export const RegistryKey = z
  .object({
    kid: z.string().min(1),
    public_key: z.string().min(1),
    status: z.enum(KEY_STATUSES),
    revoked_at: Timestamp.optional(),
  })
  .refine((k) => (k.status === "revoked") === (k.revoked_at !== undefined), {
    message: "revoked_at is present exactly when status is revoked",
    path: ["revoked_at"],
  });
export type RegistryKey = z.infer<typeof RegistryKey>;

const keysBody = z.strictObject({
  kind: z.literal("keys"),
  ...documentHead,
  keys: z.array(RegistryKey),
});
export const UnsignedKeysDocument = keysBody.refine(hasStandardExpiry, expiryIssue);
export const KeysDocument = keysBody.extend(signature).refine(hasStandardExpiry, expiryIssue);
export type KeysDocument = z.infer<typeof KeysDocument>;

const versionsBody = z.strictObject({
  kind: z.literal("versions"),
  pack: PackName,
  ...documentHead,
  versions: z.array(IndexVersion),
});
export const VersionsDocument = versionsBody.extend(signature).refine(hasStandardExpiry, expiryIssue);
export type VersionsDocument = z.infer<typeof VersionsDocument>;
