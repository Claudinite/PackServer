import type { Clock } from "@packserver/ports";
import { reachRequest, releaseProblem, RELEASE_HEADER, type ApiRequest, type ApiResponse, type Reach } from "@packserver/test-world/http-runtime";

export const REQUEST_TIMEOUT_MS = 10_000;
/** A fixture or a document is a few kilobytes; anything past this is not one. */
export const MAX_BODY_BYTES = 1 << 20;

/** A response that cannot be from the release the probe pinned. */
export class ReleaseMismatch extends Error {
  override readonly name = "ReleaseMismatch";
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new Error(`a response declares ${declared} bytes`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) throw new Error(`a response is ${bytes.length} bytes`);
  return bytes;
}

export interface SenderOptions {
  reach: Reach;
  /** Every response must name this release; null still requires it to name one. */
  expectedRelease: string | null;
  clock: Clock;
  fetch: typeof fetch;
}

/** The registry's own Workers: the `http` driver's headers and release assertion, over a Worker's `fetch`. */
export function registrySender(options: SenderOptions): (req: ApiRequest) => Promise<ApiResponse> {
  const expected = options.expectedRelease === null ? null : new Set([options.expectedRelease]);
  return async (req) => {
    const { url, headers } = await reachRequest(options.reach, req, { nowMs: options.clock.now(), nonce: crypto.randomUUID() });
    let body: string | undefined;
    if (req.body !== undefined) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (typeof req.body !== "string") headers["content-type"] ??= "application/json";
    }
    const res = await options.fetch(url.toString(), { method: req.method, headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(body === undefined ? {} : { body }) });
    const text = new TextDecoder().decode(await readCapped(res));
    const problem = releaseProblem(expected, url.toString(), res.status, res.headers.get(RELEASE_HEADER));
    if (problem) throw new ReleaseMismatch(problem);
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) as unknown };
  };
}

/** The CDN: bytes, with no credential and no release header to expect. */
export async function fetchBytes(doFetch: typeof fetch, url: string): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { status: res.status, bytes: await readCapped(res) };
}
