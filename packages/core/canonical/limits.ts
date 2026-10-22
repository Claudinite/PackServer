const MiB = 1024 * 1024;

/** REQ-VAL-022, ARCH step 2. Sizes are binary megabytes. */
export const LIMITS = {
  /** Stored length of the uploaded archive (validation-pipeline step 2). */
  archiveBytes: 3 * MiB,
  totalUnpackedBytes: 20 * MiB,
  fileBytes: 5 * MiB,
  /** Regular-file entries; directories are bounded by the depth and path limits and the unpacked cap. */
  files: 5_000,
  /** File content bytes over stored bytes for the archive as a whole. */
  ratio: 100,
  pathDepth: 32,
  pathBytes: 4_096,
  componentBytes: 255,
  windowBytes: 8 * MiB,
  /** An extended (PAX) header is a handful of short records. */
  paxBytes: 64 * 1024,
} as const;

/**
 * Stored length of a canonical archive: it is raw-framed, so the unpacked cap plus the frame and
 * block headers (3 bytes per 128 KiB block) bounds it.
 */
export const CANONICAL_ARCHIVE_BYTES = LIMITS.totalUnpackedBytes + 4096;

/** The canonical zstd frame: raw blocks only, so the bytes are a pure function of the tar. */
export const ZSTD = {
  windowLog: 23,
  blockBytes: 128 * 1024,
} as const;
