import type { ApiResponse } from "@packserver/test-world/http-runtime";
import type { Send } from "./types";

/** Where each Worker answers its self-test on the gated host; the admin Worker has a host of its own and is not reached. */
export const SELFTEST_PATHS = {
  validator: "/validator/__selftest",
  publish: "/api/publish/__selftest",
  github: "/github/__selftest",
  mcp: "/mcp/__selftest",
  web: "/__selftest",
  judge: "/judge/__selftest",
  prober: "/prober/__selftest",
} as const;
export type SelfTestWorker = keyof typeof SELFTEST_PATHS;

export interface SelfTestResult {
  worker: SelfTestWorker;
  /** The version that answered; null when nothing usable did. */
  versionId: string | null;
  releaseId: string | null;
  ok: boolean;
  detail: string;
}

const failed = (worker: SelfTestWorker, detail: string): SelfTestResult => ({ worker, versionId: null, releaseId: null, ok: false, detail });

function shape(worker: SelfTestWorker, res: ApiResponse): SelfTestResult {
  if (res.status !== 200) return failed(worker, `${worker} self-test answered ${res.status}`);
  let body: unknown;
  try {
    body = res.json();
  } catch {
    return failed(worker, `${worker} self-test answered no JSON`);
  }
  const b = body as { version_id?: unknown; release_id?: unknown; ok?: unknown; checks?: unknown };
  if (typeof b.version_id !== "string" || typeof b.release_id !== "string" || typeof b.ok !== "boolean" || !Array.isArray(b.checks)) return failed(worker, `${worker} self-test answered an unknown shape`);
  const bad = b.checks.flatMap((c: unknown) => (c !== null && typeof c === "object" && (c as { ok?: unknown }).ok === false && typeof (c as { name?: unknown }).name === "string" ? [(c as { name: string }).name] : []));
  return { worker, versionId: b.version_id, releaseId: b.release_id, ok: b.ok, detail: b.ok ? `${worker} self-test passed` : `${worker} self-test failed: ${bad.join(", ") || "no check named"}` };
}

/** Every reachable Worker's self-test, shallow unless `full`; one that cannot be reached is a failed result, not a missing one. */
export async function runSelfTests(send: Send, full: boolean, workers: readonly SelfTestWorker[] = Object.keys(SELFTEST_PATHS) as SelfTestWorker[]): Promise<SelfTestResult[]> {
  return Promise.all(
    workers.map(async (worker) => {
      try {
        return shape(worker, await send({ surface: worker, method: "GET", path: full ? SELFTEST_PATHS[worker] : `${SELFTEST_PATHS[worker]}?shallow=1` }));
      } catch (error) {
        return failed(worker, `${worker} self-test was not reached: ${error instanceof Error ? error.name : "error"}`);
      }
    }),
  );
}
