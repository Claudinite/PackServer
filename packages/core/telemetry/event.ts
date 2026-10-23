import { scrubIp } from "./hashing";

export const PRINCIPAL_KINDS = ["anonymous", "session", "token", "oidc", "service", "admin", "synthetic"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const OUTCOMES = ["ok", "refused", "client_error", "server_error", "exception", "canceled"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const TIMINGS = ["d1_ms", "r2_ms", "kv_ms", "do_ms", "vectorize_ms", "upstream_ms"] as const;
export type Timing = (typeof TIMINGS)[number];

/** The `http.request` wide event; an absent field is unknown, never an empty string or a zero. */
export interface WideEvent {
  worker: string;
  "http.route": string;
  method: string;
  status: number;
  outcome: Outcome;
  journey?: string;
  error_code?: string;
  principal_kind: PrincipalKind;
  principal_hash?: string;
  scope?: string;
  pack?: string;
  client?: string;
  client_version?: string;
  ip_hash?: string;
  country?: string;
  duration_ms: number;
  cpu_ms?: number;
  d1_ms?: number;
  r2_ms?: number;
  kv_ms?: number;
  do_ms?: number;
  vectorize_ms?: number;
  upstream_ms?: number;
  version_id: string;
  release_id: string;
  colo?: string;
  cache_status?: string;
  version_override: boolean;
  is_synthetic: boolean;
}

/** Column order of the `request_outcomes` point; `index1` is `version_id`. Append only. */
export const REQUEST_BLOBS = [
  "worker", "http.route", "method", "journey", "outcome", "error_code", "principal_kind", "principal_hash", "scope",
  "pack", "client", "client_version", "ip_hash", "country", "release_id", "colo", "cache_status",
] as const satisfies readonly (keyof WideEvent)[];
export const REQUEST_DOUBLES = [
  "status", "duration_ms", "cpu_ms", "d1_ms", "r2_ms", "kv_ms", "do_ms", "vectorize_ms", "upstream_ms", "version_override", "is_synthetic",
] as const satisfies readonly (keyof WideEvent)[];

/** Analytics Engine has no null for a double, so an unknown measurement is -1 (a real one is never negative). */
export const UNKNOWN_DOUBLE = -1;

export function requestPoint(event: WideEvent): { name: "http.request"; index: string; blobs: string[]; doubles: number[] } {
  return {
    name: "http.request",
    index: event.version_id,
    blobs: REQUEST_BLOBS.map((k) => String(event[k] ?? "")),
    doubles: REQUEST_DOUBLES.map((k) => {
      const v = event[k];
      return v === undefined ? UNKNOWN_DOUBLE : typeof v === "boolean" ? Number(v) : (v as number);
    }),
  };
}

/** The Workers Logs line: the event's known fields as one JSON object. */
export function consoleLine(event: WideEvent): string {
  const known = Object.fromEntries(Object.entries(event).filter(([, v]) => v !== undefined));
  return JSON.stringify({ event: "http.request", ...known });
}

/** Strings that reach an event from a handler are checked for an address-shaped value. */
export const clean = (value: string | undefined): string | undefined => (value === undefined ? undefined : scrubIp(value));

export interface ParsedClient {
  client: string;
  client_version?: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export const knownMethod = (method: string): string => ((METHODS as readonly string[]).includes(method) ? method : "OTHER");

/** Only cn's own `cn/<version>` is kept verbatim; any other agent is a coarse class so free text is never stored. */
export function parseUserAgent(userAgent: string | null | undefined): ParsedClient | undefined {
  if (!userAgent) return undefined;
  const cn = /^cn\/(.{1,64})$/.exec(userAgent.trim());
  if (cn) {
    const version = cn[1] as string;
    return SEMVER.test(version) && scrubIp(version) === version ? { client: "cn", client_version: version } : { client: "cn" };
  }
  return { client: /^Mozilla\//.test(userAgent) ? "browser" : "other" };
}

export function outcomeFor(status: number): Outcome {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "ok";
}
