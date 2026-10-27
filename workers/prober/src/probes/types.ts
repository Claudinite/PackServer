import type { Clock, KV } from "@packserver/ports";
import type { ApiRequest, ApiResponse, Reach } from "@packserver/test-world/http-runtime";
import type { ProberConfig } from "../config";

export type Send = (req: ApiRequest) => Promise<ApiResponse>;

/** One scenario's result. `staleS` is only meaningful to the index scenario. */
export interface ProbeOutcome {
  ok: boolean;
  /** Written by the probe from facts it holds, never a body the registry sent. */
  detail: string;
  staleS?: number | null;
}

export interface ProbeContext {
  config: ProberConfig;
  /** Requests the registry as a visitor of the target would make them. */
  registry: Send;
  clock: Clock;
  /** Where serials already verified are kept, so a rollback is seen. */
  kv: KV;
  fetch: typeof fetch;
}

export type Probe = (ctx: ProbeContext) => Promise<ProbeOutcome>;

export interface Target {
  /** `production`, or the candidate's release id. */
  name: string;
  reach: Reach;
  /** The release every response must name; null when the target is whatever production serves. */
  expectedRelease: string | null;
}

export const pass = (detail: string, extra: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ ok: true, detail, ...extra });
export const fail = (detail: string, extra: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ ok: false, detail, ...extra });
