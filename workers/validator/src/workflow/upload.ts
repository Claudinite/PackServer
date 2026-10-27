import type { ValidatorRuntime } from "../bindings";
import type { RunInput } from "./run";

/** Whose runs a rescan starts: they are dry-runs of a published version, so they promote nothing and count against nobody's caps. */
export const RESCAN_PRINCIPAL = "system:rescan";

/** A rescan run has no upload: its staging key names the published canonical archive it re-validates. */
export const rescanUploadKey = (visibility: "public" | "private", key: string): string => `rescan:${visibility}:${key}`;

export interface Upload {
  head(): Promise<{ size: number } | null>;
  get(): Promise<Uint8Array | null>;
}

/** The bytes a run validates: the publisher's staged upload, or for a rescan the published archive. */
export function uploadOf(rt: ValidatorRuntime, run: Pick<RunInput, "principal" | "staging_key">): Upload {
  const rescan = run.principal === RESCAN_PRINCIPAL ? /^rescan:(public|private):(.+)$/.exec(run.staging_key) : null;
  const bucket = rescan ? (rescan[1] === "private" ? rt.ports.r2.PACKS_PRIVATE : rt.ports.r2.PACKS_PUBLIC) : rt.ports.r2.PACKS_STAGING;
  if (!bucket) throw new Error(`the ${rescan ? `PACKS_${rescan[1]!.toUpperCase()}` : "PACKS_STAGING"} binding is missing`);
  const key = rescan ? rescan[2]! : run.staging_key;
  return { head: () => bucket.head(key), get: () => bucket.get(key) };
}
