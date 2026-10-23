import { expect } from "vitest";
import { ArchiveRefusal, extractArchive, type ArchiveReason, type ExtractStats } from "../index.ts";

export async function refusal(archive: Uint8Array, stats?: ExtractStats): Promise<ArchiveRefusal> {
  try {
    await extractArchive(archive, { stats });
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveRefusal);
    return e as ArchiveRefusal;
  }
  throw new Error("expected the archive to be refused");
}

/** Decoder output allowed before a refusal: the unpacked cap plus a generous chunk of slack. */
export const WORK_BOUND = 20 * 1024 * 1024 + 1024 * 1024;

export async function expectRefused(archive: Uint8Array, reason: ArchiveReason, code?: string): Promise<ExtractStats> {
  const stats: ExtractStats = { producedBytes: 0 };
  const r = await refusal(archive, stats);
  expect(r.reason).toBe(reason);
  if (code) expect(r.code).toBe(code);
  expect(stats.producedBytes).toBeLessThanOrEqual(WORK_BOUND);
  return stats;
}
