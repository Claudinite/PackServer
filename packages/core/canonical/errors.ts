export type ArchiveReason = "archive.bomb" | "archive.unsafe";

/** A hard-fail refusal (REQ-VAL-014: never retried). `code` is the finer, stable cause. */
export class ArchiveRefusal extends Error {
  readonly reason: ArchiveReason;
  readonly code: string;

  constructor(reason: ArchiveReason, code: string, detail?: string) {
    super(detail ? `${reason} (${code}): ${detail}` : `${reason} (${code})`);
    this.name = "ArchiveRefusal";
    this.reason = reason;
    this.code = code;
  }
}

export const bomb = (code: string, detail?: string) => new ArchiveRefusal("archive.bomb", code, detail);
export const unsafe = (code: string, detail?: string) => new ArchiveRefusal("archive.unsafe", code, detail);
