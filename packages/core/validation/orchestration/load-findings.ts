import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import type { SandboxBReport } from "./sandbox-reports.ts";

/** How container B's run ends for the workflow: findings, or a failure that is the platform's and not the pack's. */
export type LoadOutcome =
  | { kind: "findings"; findings: Finding[] }
  /** Nothing about the pack can be concluded; the step retries, or the run ends `error`. */
  | { kind: "infrastructure"; code: string; retry: boolean };

const MAX_EGRESS_FINDINGS = 10;

/**
 * Facts container B reported, read as findings. B returns facts and never a verdict, so every
 * class here comes from the rules version. Tool messages are quoted as data and never become the
 * hint.
 */
export function loadFindings(report: SandboxBReport, make: MakeFinding): LoadOutcome {
  if (report.outcome === "error") {
    // A tree that differs from the committed one is the same on every retry; the rest may not be.
    return { kind: "infrastructure", code: `sandbox.${report.error ?? "error"}`, retry: report.error !== "tree_hash_mismatch" };
  }
  if (report.outcome === "refused" && report.refusal) {
    return { kind: "findings", findings: [make(report.refusal.reason, { hint: `The canonical archive was refused (${report.refusal.code}).` })] };
  }
  if (report.outcome === "timeout") {
    return { kind: "findings", findings: [make("sandbox.timeout", { hint: "Loading and running the pack took longer than the 5 minute limit." })] };
  }
  if (!report.tree.matches) return { kind: "infrastructure", code: "sandbox.tree_hash_mismatch", retry: false };

  const out: Finding[] = [];
  if (!report.min_engine.supported) {
    out.push(make("engine.unsupported_min_version", { file: "pack.json", hint: `minEngineVersion ${report.min_engine.declared} is older than the oldest supported engine, ${report.min_engine.oldest_in_mirror}.` }));
  }
  for (const engine of report.engines) {
    const { load } = engine;
    if (load.status === "failed") {
      out.push(make("load.failed", { file: load.file, quote: load.message, hint: `cn ${engine.version} could not load the pack${load.file ? ` at ${load.file}` : ""}.` }));
    } else if (load.status === "timeout") {
      out.push(make("sandbox.timeout", { file: load.file, hint: `Loading the pack with cn ${engine.version} took longer than the limit.` }));
    }
  }
  for (const c of report.compile) {
    if (c.status === "failed") out.push(make("load.compile-failed", { file: c.file, quote: c.message, hint: `${c.file ?? "A coded check"} does not compile.` }));
    else if (c.status === "timeout") out.push(make("sandbox.timeout", { file: c.file, hint: `Compiling ${c.file ?? "a coded check"} took longer than the limit.` }));
  }
  for (const d of report.declared) {
    if (d.status === "failed") out.push(make("load.declared-check-unparseable", { file: d.file, quote: d.message, hint: `${d.file ?? "A declared check"} does not parse.` }));
  }
  for (const r of report.runs) {
    const what = `${r.kind === "env_setup" ? "Env setup" : "The worker"}${r.name ? ` ${r.name}` : ""}`;
    if (r.timed_out) out.push(make("sandbox.timeout", { file: r.name, hint: `${what} ran longer than the 30 second limit.` }));
    else if (r.status === "ran" && r.exit_status !== null && r.exit_status !== 0) {
      out.push(make("load.run-nonzero", { file: r.name, hint: `${what} exited with status ${r.exit_status} (${r.run_count} run).` }));
    }
  }
  for (const e of report.egress.slice(0, MAX_EGRESS_FINDINGS)) {
    out.push(make("sandbox.egress", { file: e.run, quote: `${e.kind} ${e.target}`, hint: "Executable content tried to reach the network; it may not, at all." }));
  }
  if (report.egress_total > 0 && report.egress.length === 0) {
    out.push(make("sandbox.egress", { hint: `${report.egress_total} network attempts were recorded.` }));
  }
  return { kind: "findings", findings: out };
}
