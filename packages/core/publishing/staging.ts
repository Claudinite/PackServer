const MiB = 1024 * 1024;

/** REQ-PUB-030: a credential buys one object of at most this many bytes. */
export const MAX_UPLOAD_BYTES = 3 * MiB;
/** REQ-PUB-030: what one publisher may hold in staging at once. */
export const STAGING_PREFIX_CAP_BYTES = 50 * MiB;
/** REQ-PUB-003: the life of an upload credential, and of the presigned URL it buys. */
export const CREDENTIAL_TTL_MS = 15 * 60_000;
/** REQ-PUB-020: how long a staged object waits for a draft or run to claim it. */
export const STAGING_LIFETIME_MS = { "dry-run": 60 * 60_000, draft: 14 * 24 * 3_600_000 } as const;
export type StagingLifetime = keyof typeof STAGING_LIFETIME_MS;

export const STAGING_CONTENT_TYPE = "application/zstd";
/** The custom-metadata key a presigned PUT stamps so an object says how long it may wait. */
export const LIFETIME_METADATA_HEADER = "x-amz-meta-staging-lifetime";

/** The staging bucket's lifecycle: an incomplete multipart upload is aborted after one day (REQ-PUB-030). */
export const STAGING_LIFECYCLE_RULES = [
  { id: "abort-incomplete-multipart", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86_400 } } },
] as const;

export function stagingKey(scope: string, name: string, version: string, credentialId: string): string {
  return `staging/${scope}/${name}/${version}/${credentialId}.tar.zst`;
}

export function stagingPrefix(scope: string): string {
  return `staging/${scope}/`;
}

export function objectExpiry(issuedAtMs: number, lifetime: StagingLifetime): number {
  return issuedAtMs + STAGING_LIFETIME_MS[lifetime];
}
