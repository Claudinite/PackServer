import { WorkerEntrypoint } from "cloudflare:workers";
import { sha256Hex } from "@packserver/core/canonical";
import { compareThreePart, SandboxBRequest, type SandboxBReport } from "@packserver/core/validation";
import { PortError, type SandboxRunRequest, type SandboxRunResult } from "@packserver/ports";
import { handleControl } from "../control";
import type { BScript } from "./scripts";


const IMAGE_DIGEST = "sha256:fake-sandbox-b";

function report(request: SandboxBRequest, script: BScript): SandboxBReport {
  const supported = compareThreePart(request.min_engine_version, request.oldest_engine_in_mirror) >= 0;
  const failing = (role: "newest" | "lowest") => script.loads === false || (script.loads === "newest-engine-only" && role === "lowest");
  const runs: SandboxBReport["runs"] =
    script.exitCode === undefined
      ? []
      : [{ kind: "env_setup", name: "env/setup.sh", status: "ran", run_count: 1, exit_status: script.exitCode, signal: null, timed_out: false, egress_count: 0 }];
  const egress = (script.egressAttempts ?? []).map((target) => ({ run: null, kind: "connect" as const, target }));
  const found = script.treeMismatch ? "0".repeat(64) : request.expected_tree_hash;
  return {
    schema: 1,
    outcome: script.treeMismatch ? "error" : "ok",
    refusal: null,
    error: script.treeMismatch ? "tree_hash_mismatch" : null,
    image_digest: IMAGE_DIGEST,
    pack_code_executed: !script.treeMismatch,
    tree: { expected: request.expected_tree_hash, found, matches: !script.treeMismatch },
    min_engine: { declared: request.min_engine_version, oldest_in_mirror: request.oldest_engine_in_mirror, supported },
    engines: request.engines.map((e) => ({
      role: e.role,
      version: e.version,
      digest_verified: true,
      load: failing(e.role) ? { status: "failed" as const, exit_code: 1, file: "pack.json", message: "the engine could not load the pack" } : { status: "loaded" as const, exit_code: 0, file: null, message: null },
    })),
    compile: (script.compileFails ?? []).map((file) => ({ file, status: "failed" as const, message: "does not compile" })),
    declared: (script.declaredFails ?? []).map((file) => ({ file, status: "failed" as const, message: "does not parse" })),
    runs,
    egress,
    egress_total: egress.length,
    egress_truncated: false,
    inventory: [],
    inventory_total: 0,
    inventory_truncated: false,
    token_counts: null,
    timings_ms: { extract: 1, total: 1 },
  };
}

/**
 * Container B in the test world. It answers cleanly for any tree unless a test scripted it, and it
 * records every request, including the engine releases it was handed, so a scenario can assert
 * what reached it and, by its absence, what did not.
 */
export default class FakeSandboxB extends WorkerEntrypoint {
  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const parsed = SandboxBRequest.parse(request.request);
    const canonicalSha = await sha256Hex(request.canonical);
    ran.push({ tree_hash: parsed.expected_tree_hash, canonical_sha256: canonicalSha, engines: request.engines.map((e) => e.file) });
    const script = scripts.get(parsed.expected_tree_hash) ?? {};
    const seen = (attempts.get(parsed.expected_tree_hash) ?? 0) + 1;
    attempts.set(parsed.expected_tree_hash, seen);
    if (script.crash) throw new PortError("crashed", "the fake sandbox B container died");
    if (script.errorTimes !== undefined && seen <= script.errorTimes) return { report: { ...report(parsed, {}), outcome: "error", error: "crashed" } };
    if (script.timeoutTimes !== undefined && seen <= script.timeoutTimes) return { report: { ...report(parsed, {}), outcome: "timeout", timings_ms: { extract: 1, total: 300_001 } } };
    return { report: report(parsed, script) };
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      reset: () => {
        ran.length = 0;
        scripts.clear();
        attempts.clear();
      },
      script: ({ treeHash, script }: { treeHash: string; script: BScript }) => {
        scripts.set(treeHash, script);
        attempts.delete(treeHash);
      },
      calls: () => ({ ran }),
    });
  }
}

const ran: Array<{ tree_hash: string; canonical_sha256: string; engines: string[] }> = [];
const scripts = new Map<string, BScript>();
const attempts = new Map<string, number>();
