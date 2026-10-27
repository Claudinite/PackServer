import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { openAccessToken, type OAuthApi } from "../src/oauth";
import { allows, SCOPE_READ, SCOPE_WRITE } from "../src/oauth/scopes";
import { consentPage, escapeHtml } from "../src/oauth/page";

// `worker.ts` imports the provider package, which needs the Workers runtime, so the package is stubbed here.
async function loadRefusal() {
  vi.doMock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
  const worker = await import("../src/oauth/worker");
  return { refuseRedirectsForClientMetadata: worker.refuseRedirectsForClientMetadata, agent: `${worker.PROVIDER_AGENT_PREFIX}9.9.9` };
}

describe("client metadata fetches", () => {
  /** A fetch that behaves as the platform's does: a redirect is followed unless the caller asked for manual handling. */
  const platformFetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://client.example/meta.json") {
      if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { location: "https://client.example/moved.json" } });
      return Response.json({ client_id: "https://client.example/meta.json" });
    }
    return Response.json({ plain: true });
  }) as typeof fetch;

  it("are not redirected, and no other fetch is touched", async () => {
    const { refuseRedirectsForClientMetadata, agent } = await loadRefusal();
    const wrapped = refuseRedirectsForClientMetadata(platformFetch);
    expect((await wrapped("https://client.example/meta.json", { headers: { "User-Agent": agent }, cache: "no-store" })).status).toBe(302);
    expect((await wrapped("https://client.example/meta.json", { headers: { "User-Agent": "something-else" } })).status).toBe(200);
    expect((await wrapped("https://client.example/meta.json")).status).toBe(200);
  });

  it("are recognised by the agent the installed provider really sends", async () => {
    const { agent } = await loadRefusal();
    const source = readFileSync(createRequire(import.meta.url).resolve("@cloudflare/workers-oauth-provider").replace(/[^/]+$/, "oauth-provider.js"), "utf8");
    const sent = /OUTBOUND_USER_AGENT = `([^`$]*)/.exec(source)?.[1];
    expect(sent).toBeDefined();
    expect(sent!.startsWith(agent.replace(/9\.9\.9$/, ""))).toBe(true);
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

describe("the token endpoint gate", () => {
  it("answers 413 to a body over the cap before reading it as a form", async () => {
    vi.resetModules();
    vi.doMock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class { fetch = async () => new Response("provider", { status: 200 }); }, getOAuthApi: () => ({}) }));
    const { oauthWorker } = await import("../src/oauth/worker");
    const runtime = { ports: { kv: { OAUTH_KV: { get: async () => null, put: async () => {} } }, rateLimits: {} }, config: { resource: "https://r/mcp" }, version: { releaseId: "r" }, tokenClock: { now: () => 0 } };
    const worker = oauthWorker<object>({ fetch: async () => new Response("app") }, () => runtime as never);
    const post = (body: string) => worker.fetch!(new Request("https://r/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }) as never, {}, {} as never);
    expect((await post(`grant_type=refresh_token&refresh_token=${"x".repeat(70 * 1024)}`)).status).toBe(413);
    expect((await post("grant_type=authorization_code&code=c")).status).toBe(200);
  });
});
