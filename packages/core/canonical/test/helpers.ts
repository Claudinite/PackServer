import { expect } from "vitest";
import { ArchiveRefusal, extractArchive, type ArchiveReason } from "../index.ts";

export async function refusal(archive: Uint8Array): Promise<ArchiveRefusal> {
  try {
    await extractArchive(archive);
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveRefusal);
    return e as ArchiveRefusal;
  }
  throw new Error("expected the archive to be refused");
}

export async function expectRefused(archive: Uint8Array, reason: ArchiveReason, code?: string): Promise<void> {
  const r = await refusal(archive);
  expect(r.reason).toBe(reason);
  if (code) expect(r.code).toBe(code);
}
