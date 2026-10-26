import { B_MESSAGE_CHARS } from "@packserver/core/validation";

const MiB = 1024 * 1024;

/** REQ-VAL-045 and the report cap of validation-pipeline.md, B side. */
export const B_LIMITS = {
  extractMs: 60_000,
  runMs: 5 * 60_000,
  /** Each compile, load or run of pack content. */
  stepMs: 30_000,
  reportBytes: 256 * 1024,
  /** What is kept of one child's combined output; the rest is read and dropped. */
  outputBytes: 8 * 1024,
  egress: 100,
  inventory: 1_000,
  messageChars: B_MESSAGE_CHARS,
  workerHeapMb: 384,
  /** Input files are stat-ed against these before they are read. */
  canonicalFileBytes: 21 * MiB,
  releaseFileBytes: 200 * MiB,
} as const;
