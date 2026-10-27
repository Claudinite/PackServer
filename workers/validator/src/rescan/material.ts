import { privateArchiveKey } from "@packserver/core/access";
import { extractArchive, type Tree } from "@packserver/core/canonical";
import { objectKey } from "@packserver/core/catalog";
import { sha256Hex } from "@packserver/core/index";
import { Meta, ValidationReport, type Finding } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import type { Candidate } from "./store";

export interface Material {
  tree: Tree;
  meta: Meta;
}

export const metaKeyOf = (candidate: Candidate): string => objectKey(candidate.pack, "meta", candidate.version);

const decoder = new TextDecoder();

function bucketOf(rt: ValidatorRuntime, candidate: Candidate) {
  const bucket = candidate.visibility === "private" ? rt.ports.r2.PACKS_PRIVATE : rt.ports.r2.PACKS_PUBLIC;
  if (!bucket) throw new Error(`the ${candidate.visibility === "private" ? "PACKS_PRIVATE" : "PACKS_PUBLIC"} binding is missing`);
  return bucket;
}

export const archiveKeyOf = (candidate: Candidate): string => (candidate.visibility === "private" ? privateArchiveKey(candidate.id) : objectKey(candidate.pack, "archive", candidate.version));

/** The version's `meta.json`, or null when it is gone or unreadable. */
export async function metaOf(rt: ValidatorRuntime, candidate: Candidate): Promise<Meta | null> {
  const bytes = await bucketOf(rt, candidate).get(metaKeyOf(candidate));
  if (!bytes) return null;
  const meta = Meta.safeParse(JSON.parse(decoder.decode(bytes)));
  return meta.success ? meta.data : null;
}

/**
 * What a rescan reads of a published version: its committed archive and its `meta.json`. A version
 * whose objects are missing, or whose archive no longer hashes to the committed form, is not
 * rescanned and is reported to the caller as `null`: there is nothing to judge.
 */
export async function materialOf(rt: ValidatorRuntime, candidate: Candidate): Promise<Material | null> {
  const bucket = bucketOf(rt, candidate);
  const archive = await bucket.get(archiveKeyOf(candidate));
  const meta = await metaOf(rt, candidate);
  if (!archive || !meta) return null;
  if ((await sha256Hex(archive)) !== candidate.sha256) return null;
  try {
    return { tree: await extractArchive(archive, { canonical: true }), meta };
  } catch (error) {
    console.log(JSON.stringify({ event: "validator.rescan_unreadable", pack: candidate.pack, version: candidate.version, reason: String(error) }));
    return null;
  }
}

/** The findings the version was judged on when it was validated; null when the report is gone, so nothing is known about what a person decided. */
export async function originalFindings(rt: ValidatorRuntime, candidate: Candidate): Promise<Finding[] | null> {
  const bucket = rt.ports.r2.VALIDATION_REPORTS;
  if (!bucket || candidate.report_key === null) return null;
  const bytes = await bucket.get(candidate.report_key);
  if (!bytes) return null;
  const report = ValidationReport.safeParse(JSON.parse(decoder.decode(bytes)));
  return report.success ? report.data.findings : null;
}
