import { heldDetail } from "@packserver/core/admin";
import type { PreInstallManifest } from "@packserver/schema";
import { SandboxAReport } from "@packserver/core/validation";
import type { ValidatorRuntime } from "../bindings";
import type { StagingReason } from "../promote/load";
import { getJson, runKeys } from "../workflow/report";
import { packId, readRun } from "../workflow/run";
import { reports } from "../workflow/steps";

/** What an owner is shown before approving: what is new first, then everything else the version changes. */
export interface ApprovalSheet {
  pack: string;
  version: string;
  reasons: StagingReason[];
  /** The version adds executable capability the previous promoted one lacked (REQ-VAL-052). */
  widening: boolean;
  /** The previous promoted version the changes are taken against; none for a first publish. */
  against: string | null;
  /** Pre-install entries the previous promoted version lacked, marked "new". */
  new: string[];
  capabilities: { added: string[]; removed: string[] };
  files: Array<{ path: string; change: "added" | "removed" | "modified"; added_lines: number; removed_lines: number }>;
  files_truncated: boolean;
  preinstall: PreInstallManifest | null;
}

export async function buildSheet(rt: ValidatorRuntime, runId: string, reasons: StagingReason[]): Promise<ApprovalSheet> {
  const run = await readRun(rt.ports.d1, runId);
  const bucket = reports(rt);
  const detail = await heldDetail({ d1: rt.ports.d1, validationReports: bucket }, runId);
  const a = SandboxAReport.parse(await getJson(bucket, runKeys.sandboxA(runId)));
  const preinstall = ((a.capabilities as { preinstall?: PreInstallManifest | null } | null)?.preinstall ?? null) as PreInstallManifest | null;
  return {
    pack: packId(run),
    version: run.version,
    reasons,
    widening: reasons.includes("widening"),
    against: detail?.against?.version ?? null,
    new: preinstall?.new ?? [],
    capabilities: { added: detail?.capabilities.added ?? [], removed: detail?.capabilities.removed ?? [] },
    files: (detail?.diff?.files ?? []).map((f) => ({ path: f.path, change: f.change, added_lines: f.added_lines, removed_lines: f.removed_lines })),
    files_truncated: detail?.diff?.truncated ?? false,
    preinstall,
  };
}
