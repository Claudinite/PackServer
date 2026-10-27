import type { NetHandler } from "./net";

const DOH_HOST = "cloudflare-dns.com";
const AUTH_FILE_PATH = "/.well-known/packserver-auth";
const TXT = 16;
const ADDRESS_TYPES: Record<string, number> = { A: 1, AAAA: 28 };

/** What a host answers at the one path a domain proof reads. */
export type AuthFileSite =
  | { kind: "file"; body: string }
  | { kind: "redirect" }
  | { kind: "oversize"; bytes: number }
  | { kind: "down" };

export interface DomainRequest {
  host: string;
  path: string;
}

/**
 * The outside a domain proof meets: a DNS-over-HTTPS resolver holding TXT records and hosts that
 * serve (or fail to serve) the proof file. Every request is recorded, so a scenario can show the
 * registry asked nothing else.
 */
export class FakeDomains {
  private txt = new Map<string, string[]>();
  private hosts = new Set<string>();
  private sites = new Map<string, AuthFileSite>();
  private seen: DomainRequest[] = [];
  private resolverDown = false;

  publishTxt(name: string, value: string): void {
    this.txt.set(name, [...(this.txt.get(name) ?? []), value]);
  }
  replaceTxt(name: string, value: string): void {
    this.txt.set(name, [value]);
  }
  removeTxt(name: string): void {
    this.txt.delete(name);
  }
  /** The name has an address, as a linked site's domain does while it is registered. */
  resolveHost(name: string): void {
    this.hosts.add(name);
  }
  unresolveHost(name: string): void {
    this.hosts.delete(name);
  }
  serve(host: string, site: AuthFileSite): void {
    this.sites.set(host, site);
  }
  stopServing(host: string): void {
    this.sites.delete(host);
  }
  failResolver(down: boolean): void {
    this.resolverDown = down;
  }
  /** The requests that reached a resolver or a host since the last reset. */
  requests(): readonly DomainRequest[] {
    return this.seen;
  }
  reset(): void {
    this.txt = new Map();
    this.hosts = new Set();
    this.sites = new Map();
    this.seen = [];
    this.resolverDown = false;
  }

  readonly handler: NetHandler = (request) => {
    const url = new URL(request.url);
    if (url.host === DOH_HOST && url.pathname === "/dns-query") {
      this.seen.push({ host: url.host, path: `${url.pathname}?name=${url.searchParams.get("name") ?? ""}` });
      if (this.resolverDown) return new Response("unavailable", { status: 503 });
      const name = url.searchParams.get("name") ?? "";
      const address = ADDRESS_TYPES[url.searchParams.get("type") ?? ""];
      if (address !== undefined) {
        if (!this.hosts.has(name)) return Response.json({ Status: 3 });
        return Response.json({ Status: 0, Answer: address === 1 ? [{ name, type: 1, TTL: 60, data: "203.0.113.7" }] : [] });
      }
      const values = this.txt.get(name);
      if (!values) return Response.json({ Status: 3 });
      return Response.json({ Status: 0, Answer: values.map((v) => ({ name, type: TXT, TTL: 60, data: `"${v}"` })) });
    }
    if (url.pathname !== AUTH_FILE_PATH) return undefined;
    this.seen.push({ host: url.host, path: url.pathname });
    const site = this.sites.get(url.host);
    if (!site) return new Response("not found", { status: 404 });
    switch (site.kind) {
      case "file":
        return new Response(site.body, { status: 200, headers: { "content-type": "text/plain" } });
      case "redirect":
        // Without a Location the harness's Node fetch cannot follow it, so the port sees the 3xx itself.
        return new Response(null, { status: 302 });
      case "oversize":
        return new Response("x".repeat(site.bytes), { status: 200, headers: { "content-type": "text/plain" } });
      case "down":
        return Response.error();
    }
  };
}
