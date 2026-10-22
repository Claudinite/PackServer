const MiB = 1024 * 1024;

/** REQ-VAL-022, ARCH step 2. Sizes are binary megabytes. */
export const LIMITS = {
  /** Stored length of the uploaded archive (validation-pipeline step 2). */
  archiveBytes: 3 * MiB,
  totalUnpackedBytes: 20 * MiB,
  fileBytes: 5 * MiB,
  entries: 5_000,
  /** Unpacked bytes over stored bytes for the archive as a whole. */
  ratio: 100,
  pathDepth: 32,
  pathBytes: 4_096,
  componentBytes: 255,
  windowBytes: 8 * MiB,
  /** An extended (PAX) header is a handful of short records. */
  paxBytes: 64 * 1024,
} as const;

/** Pinned encoder parameters; the algorithm is written out in the README. */
export const ZSTD = {
  level: 12,
  windowLog: 23,
} as const;
