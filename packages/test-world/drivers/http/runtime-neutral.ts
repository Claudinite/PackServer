import { SELFTEST_SIGNATURE_HEADER, signSelfTest } from "@packserver/core/selftest";
import type { WorkerName } from "@packserver/ports";

/**
 * The half of the `http` driver that reaches a deployment, with nothing from Node and nothing
 * read from the process environment, so the Worker that probes production bundles the very code
 * the release flow runs its scenarios through.
 */

export { McpClient, type McpCallResult } from "../mcp";

export interface ApiRequest {
  /** Which Worker answers in-process; ignored by a driver that reaches the system through one public host. */
  surface: WorkerName;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** The hostname the request is addressed to, for a Worker that answers by host; in-process only, where it defaults to the Worker's own test host. */
  host?: string;
  /** Sent as an outsider would send it: a driver that signs its requests leaves this one unsigned. */
  unsigned?: boolean;
  /** The key id a signing driver signs this request as, so the call spends that principal's self-test budget. */
  signAs?: string;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  json(): unknown;
}

export interface McpCredentials {
  bearer?: string;
}

export const OVERRIDE_HEADER = "Cloudflare-Workers-Version-Overrides";
export const RELEASE_HEADER = "X-PackServer-Version";

/** What a deployment needs from a caller: where it is, which version to pin, and the credentials it accepts. */
export interface Reach {
  baseUrl: URL;
  /** The raw `Cloudflare-Workers-Version-Overrides` value; empty means none. */
  versionOverride: string;
  /** The Access service token, sent to its host only. */
  access: { clientId: string; clientSecret: string; host: string } | null;
  /** Signs every request, so a candidate that answers only signed ones (release.md §Candidate gating) answers. */
  selfTest: { key: string; keyId: string } | null;
}

export interface Clocked {
  nowMs: number;
  nonce: string;
}

/** The URL and headers a request to the deployment carries; the body and the transport stay the caller's. */
export async function reachRequest(reach: Reach, req: Pick<ApiRequest, "method" | "path" | "headers" | "unsigned" | "signAs">, at: Clocked): Promise<{ url: URL; headers: Record<string, string> }> {
  const url = new URL(req.path, reach.baseUrl);
  const headers: Record<string, string> = { ...req.headers };
  if (reach.versionOverride) headers[OVERRIDE_HEADER] = reach.versionOverride;
  if (reach.access && url.host === reach.access.host) {
    headers["CF-Access-Client-Id"] = reach.access.clientId;
    headers["CF-Access-Client-Secret"] = reach.access.clientSecret;
  }
  if (reach.selfTest && !req.unsigned) {
    headers[SELFTEST_SIGNATURE_HEADER] = await signSelfTest({
      key: reach.selfTest.key,
      keyId: req.signAs ?? reach.selfTest.keyId,
      method: req.method,
      host: url.host,
      path: url.pathname,
      nowMs: at.nowMs,
      nonce: at.nonce,
    });
  }
  return { url, headers };
}

/** Why a response cannot be the release the caller pinned, or null: Cloudflare ignores an invalid override silently. */
export function releaseProblem(expected: ReadonlySet<string> | null, url: string, status: number, release: string | null): string | null {
  if (!release) return `${url} answered ${status} without ${RELEASE_HEADER}`;
  if (expected && !expected.has(release)) return `${url} answered with ${RELEASE_HEADER} ${release}, expected ${[...expected].join(" or ")}`;
  return null;
}
