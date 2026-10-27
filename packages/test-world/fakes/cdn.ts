import type { NetHandler } from "./net";

export const CDN_PURGE_ZONE = "test-zone";
export const CDN_PURGE_TOKEN = "test-purge-token";

/** The CDN's cache purge: remembers the URLs it was asked to drop, and answers only to the zone and token the validator is configured with. */
export class FakeCdn {
  private urls: string[] = [];

  purged(): string[] {
    return [...this.urls];
  }

  reset(): void {
    this.urls = [];
  }

  readonly handler: NetHandler = async (request) => {
    if (request.method !== "POST" || request.url !== `https://api.cloudflare.com/client/v4/zones/${CDN_PURGE_ZONE}/purge_cache`) return undefined;
    if (request.headers.get("authorization") !== `Bearer ${CDN_PURGE_TOKEN}`) return Response.json({ success: false }, { status: 403 });
    const body = (await request.json()) as { files?: string[] };
    this.urls.push(...(body.files ?? []));
    return Response.json({ success: true, result: { id: "purge" } });
  };
}
