import { describe, expect, it, vi } from "vitest";
import { openAccessToken, type OAuthApi } from "../src/oauth";
import { allows, SCOPE_READ, SCOPE_WRITE } from "../src/oauth/scopes";
import { consentPage, escapeHtml } from "../src/oauth/page";

// `worker.ts` imports the provider package, which needs the Workers runtime, so the package is stubbed here.
async function loadRefusal() {
  vi.doMock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
  return (await import("../src/oauth/worker")).refuseRedirectsForClientMetadata;
}

describe("client metadata fetches", () => {
  it("refuse to follow a redirect, and no other fetch is touched", async () => {
    const refuseRedirectsForClientMetadata = await loadRefusal();
    const seen: Array<RequestInit | undefined> = [];
    const wrapped = refuseRedirectsForClientMetadata((async (_input: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response("{}");
    }) as typeof fetch);
    await wrapped("https://client.example/meta.json", { headers: { "User-Agent": "workers-oauth-provider/1.2.4 (+https://example)" }, cache: "no-store" });
    await wrapped("https://other.example/", { headers: { "User-Agent": "something-else" } });
    await wrapped("https://plain.example/");
    expect(seen[0]?.redirect).toBe("manual");
    expect(seen[1]?.redirect).toBeUndefined();
    expect(seen[2]).toBeUndefined();
  });
});

describe("scopes", () => {
  it("lets write imply read and nothing else", () => {
    expect(allows([SCOPE_WRITE], SCOPE_READ)).toBe(true);
    expect(allows([SCOPE_READ], SCOPE_WRITE)).toBe(false);
    expect(allows([], SCOPE_READ)).toBe(false);
  });
});

describe("the consent page", () => {
  const consent = {
    clientId: "https://app.example/client.json",
    clientName: "<img src=x onerror=alert(1)>",
    clientUri: "https://app.example/",
    logoUri: "https://app.example/logo.png",
    redirectUri: "http://127.0.0.1:1/cb",
    redirectHost: "127.0.0.1",
    redirectIsLoopback: true,
    scope: ["packs:read"],
  };
  const html = consentPage({ consent, handle: "h", csrf: "t", action: "/oauth/authorize", person: "ann" });

  it("leads with the origin, escapes the name and shows no logo", () => {
    expect(html).toContain("https://app.example asks to connect");
    expect(html).not.toContain("<img");
    expect(html).toContain(escapeHtml(consent.clientName));
    expect(html).not.toContain("logo.png");
    expect(html).toContain("unverified client");
    expect(html).toContain("any program here could be listening");
  });
});

describe("opening an access token", () => {
  const api = (token: unknown): OAuthApi => ({ unwrapToken: async () => token }) as unknown as OAuthApi;
  const base = { userId: "u", grantId: "g", scope: ["packs:read"], audience: "https://r/mcp", grant: { clientId: "c", scope: ["packs:read"], props: { userId: "u", issuedAt: 1_000 } } };
  const clock = (now: number) => ({ now: () => now });

  it("accepts one for this resource inside its hour", async () => {
    expect(await openAccessToken(api(base), clock(1_000 + 3_599_000), "https://r/mcp", "t")).toMatchObject({ userId: "u", grantId: "g", scopes: ["packs:read"] });
  });

  it("refuses one past its hour on the registry's clock, for another audience, with no issue time, or for another person", async () => {
    expect(await openAccessToken(api(base), clock(1_000 + 3_600_000), "https://r/mcp", "t")).toBeNull();
    expect(await openAccessToken(api({ ...base, audience: "https://other/mcp" }), clock(1_000), "https://r/mcp", "t")).toBeNull();
    expect(await openAccessToken(api({ ...base, audience: ["https://r/mcp", "https://x"] }), clock(1_000), "https://r/mcp", "t")).toBeNull();
    expect(await openAccessToken(api({ ...base, grant: { ...base.grant, props: { userId: "u" } } }), clock(1_000), "https://r/mcp", "t")).toBeNull();
    expect(await openAccessToken(api({ ...base, userId: "v" }), clock(1_000), "https://r/mcp", "t")).toBeNull();
    expect(await openAccessToken(api(null), clock(1_000), "https://r/mcp", "t")).toBeNull();
  });
});
