import type { Finding } from "@packserver/schema";
import type { R2 } from "@packserver/ports";
import type { StepName } from "@packserver/core/validation";

/** Everything a run writes to `validation-reports`, under one prefix per run. The sandbox output sits here as the registry wrote it, never as the sandbox did. */
export const runKeys = {
  sandboxA: (runId: string) => `runs/${runId}/sandbox-a.json`,
  sandboxB: (runId: string) => `runs/${runId}/sandbox-b.json`,
  canonical: (runId: string) => `runs/${runId}/canonical.tar.zst`,
  findings: (runId: string, step: StepName) => `runs/${runId}/findings/${step}.json`,
  /** The report the publisher and, once published, the public read. */
  report: (runId: string) => `runs/${runId}/report.json`,
  /** What only an admin and calibration see: the implementation that ran, the tripped questions, the probabilities. */
  admin: (runId: string) => `runs/${runId}/admin.json`,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function putJson(bucket: R2, key: string, value: unknown): Promise<void> {
  await bucket.put(key, encoder.encode(JSON.stringify(value)), { content_type: "application/json" });
}

export async function getJson<T>(bucket: R2, key: string): Promise<T> {
  const bytes = await bucket.get(key);
  if (!bytes) throw new Error(`${key} is not in validation-reports`);
  return JSON.parse(decoder.decode(bytes)) as T;
}

export async function putFindings(bucket: R2, runId: string, step: StepName, findings: readonly Finding[]): Promise<void> {
  await putJson(bucket, runKeys.findings(runId, step), findings);
}

export async function getFindings(bucket: R2, runId: string, step: StepName): Promise<Finding[]> {
  const bytes = await bucket.get(runKeys.findings(runId, step));
  return bytes ? (JSON.parse(decoder.decode(bytes)) as Finding[]) : [];
}
