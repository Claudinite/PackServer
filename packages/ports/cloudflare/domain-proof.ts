import { PortError, type AuthFileAnswer, type Dns, type WellKnown } from "../src/ports";

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
export const AUTH_FILE_PATH = "/.well-known/packserver-auth";
/** A token file is a few dozen bytes; anything past this is not one. */
export const AUTH_FILE_MAX_BYTES = 1024;
const TIMEOUT_MS = 5000;
const TXT = 16;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host a URL parser would read as an address, or one it would rewrite, is not a name to ask for a file. */
function isPlainName(host: string): boolean {
  if (!HOST.test(host) || /^(0x[0-9a-f]*|[0-9]+)$/.test(host.slice(host.lastIndexOf(".") + 1))) return false;
  try {
    return new URL(`https://${host}`).hostname === host;
  } catch {
    return false;
  }
}

/** A TXT answer's `data` is one or more quoted strings that a resolver joins back into one value. */
function txtValue(data: string): string {
  const quoted = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
  return quoted.length > 0 ? quoted.join("") : data;
}

/** TXT lookups over DNS-over-HTTPS (JSON): the registry's only DNS egress. */
export function dohDns(fetcher: typeof fetch = fetch): Dns {
  return {
    async resolveTxt(name) {
      const url = new URL(DOH_URL);
      url.searchParams.set("name", name);
      url.searchParams.set("type", "TXT");
      const response = await fetcher(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new PortError("dns_unavailable", `the resolver answered ${response.status}`);
      const body = (await response.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      // NXDOMAIN (3) and an empty answer both mean no record; any other failure status is a resolver fault.
      if (body.Status !== undefined && body.Status !== 0 && body.Status !== 3) throw new PortError("dns_unavailable", `the resolver reported status ${body.Status}`);
      return (body.Answer ?? []).filter((a) => a.type === TXT && typeof a.data === "string").map((a) => txtValue(a.data!));
    },
  };
}

async function readCapped(response: Response, cap: number): Promise<string | null> {
  if (Number(response.headers.get("content-length") ?? 0) > cap) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The domain proof's one HTTPS fetch: that host, that path, no redirect followed, a small body (REQ-SCOPE-017).
 * A name that resolves to a private address is left to Workers' egress, which does not reach private networks.
 */
export function wellKnownPort(fetcher: typeof fetch = fetch): WellKnown {
  return {
    async authFile(host): Promise<AuthFileAnswer> {
      if (!isPlainName(host)) return { status: "absent", reason: "unreachable" };
      let response: Response;
      try {
        response = await fetcher(`https://${host}${AUTH_FILE_PATH}`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/plain" } });
      } catch {
        return { status: "absent", reason: "unreachable" };
      }
      if (response.status >= 300 && response.status < 400) return { status: "absent", reason: "redirected" };
      if (response.status === 404 || response.status === 410) return { status: "absent", reason: "not_found" };
      if (!response.ok) return { status: "absent", reason: "unreachable" };
      const body = await readCapped(response, AUTH_FILE_MAX_BYTES);
      return body === null ? { status: "absent", reason: "too_large" } : { status: "found", body };
    },
  };
}
