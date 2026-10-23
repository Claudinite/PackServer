import { WorkerEntrypoint } from "cloudflare:workers";
import { PortError, type SandboxAReport, type SandboxBReport } from "@packserver/ports";
import { handleControl } from "../control";

/** One fake sandbox container: scripted per key by the test process, and it records what it was asked. */
export function sandboxEntrypoint() {
  const inspected: string[] = [];
  const ran: string[] = [];
  const reportsA = new Map<string, SandboxAReport>();
  const reportsB = new Map<string, SandboxBReport>();
  return class FakeSandboxWorker extends WorkerEntrypoint {
    async inspect(request: { archive_key: string }): Promise<SandboxAReport> {
      inspected.push(request.archive_key);
      const report = reportsA.get(request.archive_key);
      if (!report) throw new PortError("unscripted", `no sandbox A script for ${request.archive_key}`);
      return report;
    }
    async run(request: { canonical_key: string; tree_hash: string }): Promise<SandboxBReport> {
      ran.push(request.canonical_key);
      const report = reportsB.get(request.canonical_key);
      if (!report) throw new PortError("unscripted", `no sandbox B script for ${request.canonical_key}`);
      return report;
    }

    async fetch(request: Request): Promise<Response> {
      return handleControl(request, {
        reset: () => {
          inspected.length = 0;
          ran.length = 0;
          reportsA.clear();
          reportsB.clear();
        },
        scriptInspect: ({ key, report }: { key: string; report: SandboxAReport }) => void reportsA.set(key, report),
        scriptRun: ({ key, report }: { key: string; report: SandboxBReport }) => void reportsB.set(key, report),
        calls: () => ({ inspected, ran }),
      });
    }
  };
}
