/**
 * Where the validator writes a private pack's signed entry and its archives in `packs-private`, and
 * where the serving Worker reads them. Both are keyed by ids that name no pack.
 */
export const privateEntryKey = (packId: string): string => `private-index/${packId}.json`;
export const privateArchiveKey = (versionId: string): string => `v/${versionId}/pack.tar.zst`;

export const FETCH_LOG_RETENTION_DAYS = 90;
