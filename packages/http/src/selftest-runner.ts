import type { Clock } from "@packserver/ports";

export const SELFTEST_CHECK_TIMEOUT_MS = 2_000;
export const SELFTEST_TOTAL_TIMEOUT_MS = 10_000;

/** The only text a check result may carry; no secret or user data can fit in it. */
export const SELFTEST_DETAILS = ["ok", "failed", "timeout", "error"] as const;
export type SelfTestDetail = (typeof SELFTEST_DETAILS)[number];

/** REQ-OPS-010: a shallow run skips every check that calls another host or Worker, named by prefix. */
export const SHALLOW_SKIPPED_PREFIXES = ["outbound.", "service."] as const;

export interface SelfTestCheck {
  name: string;
  /** Resolves false (or rejects) to fail; must not write outside the canary objects. */
  run: () => Promise<boolean | void>;
}

export interface SelfTestCheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: SelfTestDetail;
}

export interface SelfTestResult {
  version_id: string;
  release_id: string;
  ok: boolean;
  checks: SelfTestCheckResult[];
}

export interface SelfTestOptions {
  versionId: string;
  releaseId: string;
  checks: readonly SelfTestCheck[];
  shallow?: boolean;
  clock: Clock;
}

// The timer catches a check that never settles; the injected clock catches one that overran while it ran.
const TIMED_OUT = Symbol("timed-out");

async function runOne(check: SelfTestCheck, budgetMs: number, clock: Clock): Promise<{ ok: boolean; detail: SelfTestDetail }> {
  if (budgetMs <= 0) return { ok: false, detail: "timeout" };
  const began = clock.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
  });
  try {
    const outcome = await Promise.race([check.run(), timeout]);
    if (outcome === TIMED_OUT || clock.now() - began > budgetMs) return { ok: false, detail: "timeout" };
    return outcome === false ? { ok: false, detail: "failed" } : { ok: true, detail: "ok" };
  } catch {
    return { ok: false, detail: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the checks one after another so the total limit holds; a check past the budget reports a timeout unrun. */
export async function runSelfTest(options: SelfTestOptions): Promise<SelfTestResult> {
  const started = options.clock.now();
  const selected = options.shallow ? options.checks.filter((c) => !SHALLOW_SKIPPED_PREFIXES.some((p) => c.name.startsWith(p))) : options.checks;
  const checks: SelfTestCheckResult[] = [];
  for (const check of selected) {
    const checkStarted = options.clock.now();
    const remaining = SELFTEST_TOTAL_TIMEOUT_MS - (checkStarted - started);
    const { ok, detail } = await runOne(check, Math.min(SELFTEST_CHECK_TIMEOUT_MS, remaining), options.clock);
    checks.push({ name: check.name, ok, ms: Math.max(0, options.clock.now() - checkStarted), detail });
  }
  return {
    version_id: options.versionId,
    release_id: options.releaseId,
    ok: checks.every((c) => c.ok),
    checks,
  };
}
