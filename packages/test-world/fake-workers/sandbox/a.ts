import { WorkerEntrypoint } from "cloudflare:workers";
import { sha256Hex } from "@packserver/core/canonical";
import { PortError, SANDBOX_DIED, type SandboxInspectRequest, type SandboxInspectResult } from "@packserver/ports";
import { loadOptionalInspectors } from "@packserver/sandbox-runner/a-inspectors.ts";
import { errorReport } from "@packserver/sandbox-runner/a-report.ts";
import { runA, type RunRequest } from "@packserver/sandbox-runner/a-run.ts";
import { handleControl } from "../control";
import type { AScript } from "./scripts";


const IMAGE_DIGEST = "sha256:fake-sandbox-a";

/**
 * Container A in the test world: the bounded extraction, static inspectors and canonical re-pack
 * run for real, in the same code the image runs, so every archive fixture meets the real limits.
 * Only the container around it is faked.
 */
export default class FakeSandboxA extends WorkerEntrypoint {
  async inspect(request: SandboxInspectRequest): Promise<SandboxInspectResult> {
    const sha = await sha256Hex(request.upload);
    inspected.push(sha);
    const script = scripts.get(sha) ?? {};
    const seen = (attempts.get(sha) ?? 0) + 1;
    attempts.set(sha, seen);
    const asked = request.request as RunRequest;
    const base = { rulesVersion: asked.rules_version, imageDigest: IMAGE_DIGEST };
    if (script.crash) throw new PortError("crashed", `${SANDBOX_DIED}: the fake sandbox A container died`);
    if (script.errorTimes !== undefined && seen <= script.errorTimes) return { report: errorReport(base, "scripted failure", { extract: null, total: 0 }), canonical: null };
    if (script.timeout) return { report: errorReport(base, "scripted timeout", { extract: null, total: 300_001 }, "timeout"), canonical: null };
    const { inspectors, skipped } = await loadOptionalInspectors();
    const result = await runA(request.upload, asked, { imageDigest: IMAGE_DIGEST, inspectors, skippedInspectors: skipped });
    if (script.lieAboutCanonical && result.canonical) result.canonical = Uint8Array.from(result.canonical, (b, i) => (i === 0 ? b ^ 1 : b));
    return { report: result.report, canonical: result.canonical };
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      reset: () => {
        inspected.length = 0;
        scripts.clear();
        attempts.clear();
      },
      script: ({ sha256, script }: { sha256: string; script: AScript }) => {
        scripts.set(sha256, script);
        attempts.delete(sha256);
      },
      calls: () => ({ inspected }),
    });
  }
}

const inspected: string[] = [];
const scripts = new Map<string, AScript>();
const attempts = new Map<string, number>();
