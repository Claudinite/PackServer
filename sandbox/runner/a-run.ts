import { ArchiveRefusal, canonicalise, extractArchive, isCanonical, type Canonical, type Tree } from "@packserver/core/canonical";
import { archiveFinding, findingFactory, runStaticRules, type StaticRulePorts } from "@packserver/core/validation";
import { loadRules } from "@packserver/rules";
import type { Finding } from "@packserver/schema";
import type { Inspector } from "./a-inspectors.ts";
import { errorReport, fitToCap, refusedReport, SandboxAReport, type ReportBase } from "./a-report.ts";

/** Everything the Worker knows that the container cannot look up: D1 answers, snapshotted per run. */
export interface RunRequest {
  pack: string;
  newest_version: string | null;
  rules_version: string;
  lookups: {
    popular_packs: string[];
    verified_scopes: string[];
    proven_domain_labels: { label: string; scope: string }[];
    /** Packs the publishing principal may read; any other name answers unreadable. */
    readable_packs: string[];
  };
  previous_capabilities: unknown;
}

export interface RunHooks {
  imageDigest: string | null;
  inspectors?: Inspector[];
  skippedInspectors?: { name: string; note: string }[];
  /** Called just before the decoder is handed the archive, so the supervisor starts the 60 s extraction deadline there. */
  onExtracting?: () => void;
  /** Called once extraction has finished, so the supervisor can move to the 5 min run deadline. */
  onExtracted?: () => void;
  now?: () => number;
}

export interface RunResult {
  report: SandboxAReport;
  /** The canonical archive, present exactly when the outcome is `ok`. */
  canonical: Uint8Array | null;
}

function portsOf(lookups: RunRequest["lookups"]): StaticRulePorts {
  const readable = new Set(lookups.readable_packs);
  return {
    popularPacks: async () => lookups.popular_packs,
    verifiedScopes: async () => lookups.verified_scopes,
    provenDomainLabels: async () => lookups.proven_domain_labels,
    canRead: async (pack) => readable.has(pack),
  };
}

/**
 * Validation-pipeline steps 3 to 7 over one upload: bounded extraction, the static inspectors, the
 * canonical re-pack and its round-trip check. Pack content is only ever read as bytes and text.
 */
export async function runA(upload: Uint8Array, request: RunRequest, hooks: RunHooks): Promise<RunResult> {
  const now = hooks.now ?? Date.now;
  const started = now();
  const base: ReportBase = { rulesVersion: request.rules_version, imageDigest: hooks.imageDigest };
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const make = findingFactory(loadRules(request.rules_version));

  let tree: Tree;
  hooks.onExtracting?.();
  try {
    tree = await extractArchive(upload);
  } catch (e) {
    if (e instanceof ArchiveRefusal) {
      const t = elapsed();
      return { report: refusedReport(base, e.reason, e.code, archiveFinding(e, make), { extract: t, total: t }), canonical: null };
    }
    // A decoder that dies on an archive is a verdict on that archive; retrying would only repeat it.
    const crash = new ArchiveRefusal("archive.unsafe", "extract-crash");
    const t = elapsed();
    return { report: refusedReport(base, crash.reason, crash.code, archiveFinding(crash, make), { extract: t, total: t }), canonical: null };
  }
  const extractMs = elapsed();
  hooks.onExtracted?.();

  try {
    const statics = await runStaticRules(
      { tree, pack: request.pack, newestVersion: request.newest_version, rulesVersion: request.rules_version },
      portsOf(request.lookups),
    );
    const findings: Finding[] = [...statics.findings];
    const inspectors: SandboxAReport["inspectors"] = (hooks.skippedInspectors ?? []).map((s) => ({ name: s.name, status: "skipped", note: s.note }));
    let capabilities: unknown = null;
    for (const inspector of hooks.inspectors ?? []) {
      const out = await inspector.inspect({ tree, pack: request.pack, previousCapabilities: request.previous_capabilities });
      findings.push(...out.findings);
      if (out.capabilities !== undefined) capabilities = out.capabilities;
      inspectors.push({ name: inspector.name, status: "ran", note: null });
    }

    const canonical = canonicalise(tree);
    const roundTrip = await roundTrips(canonical);
    const total = elapsed();
    const report: SandboxAReport = {
      schema: 1,
      outcome: roundTrip ? "ok" : "error",
      image_digest: hooks.imageDigest,
      rules_version: request.rules_version,
      pack_code_executed: false,
      refusal: null,
      tree_hash: canonical.treeHash,
      canonical_sha256: canonical.sha256,
      canonical_bytes: canonical.archive.length,
      file_count: tree.files.length,
      round_trip_ok: roundTrip,
      findings,
      findings_total: findings.length,
      findings_truncated: false,
      manifest: statics.manifest as Record<string, unknown> | null,
      urls: statics.urls as unknown as Record<string, unknown>[],
      capabilities,
      inspectors,
      timings_ms: { extract: extractMs, total },
      error: roundTrip ? null : "canonical re-pack did not round-trip to the validated tree",
    };
    const fitted = fitToCap(report);
    if (!fitted) return { report: errorReport(base, "report over the size cap", { extract: extractMs, total }), canonical: null };
    return { report: SandboxAReport.parse(fitted), canonical: roundTrip ? canonical.archive : null };
  } catch {
    return { report: errorReport(base, "inspection crashed", { extract: extractMs, total: elapsed() }), canonical: null };
  }
}

/** The re-pack must be canonical and must extract to the tree it was made from. */
async function roundTrips(canonical: Canonical): Promise<boolean> {
  if (!(await isCanonical(canonical.archive))) return false;
  const again = await extractArchive(canonical.archive, { canonical: true });
  return canonicalise(again).treeHash === canonical.treeHash;
}
