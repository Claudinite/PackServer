const MiB = 1024 * 1024;

/** REQ-VAL-045 and the report cap of validation-pipeline.md; the registry enforces the same wall-clock from outside. */
export const A_LIMITS = {
  extractMs: 60_000,
  runMs: 5 * 60_000,
  reportBytes: 1 * MiB,
  findings: 500,
  urls: 200,
  workerHeapMb: 384,
} as const;
