import { VirtualAuthenticator } from "@packserver/core/identity/virtual-authenticator";
import { migratedD1 } from "@packserver/core/identity/testing";
import { oidcConfig } from "@packserver/core/publishing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts, FakeRateLimit } from "@packserver/ports/fakes";
import { expect } from "vitest";
import { createApp } from "../src/app";
import type { WebConfig, WebRuntime } from "../src/bindings";

export const ORIGIN = "https://registry.example";

export const PINS = { actionSha: "0123456789abcdef0123456789abcdef01234567", cnVersion: "1.2.3", cnSha256: "ab".repeat(32) };

export function setup(config: Partial<WebConfig> = {}) {
  const fakes = createFakePorts({ worker: "web" });
  const { d1 } = migratedD1();
  const runtime: WebRuntime = {
    worker: "web", environment: "test", version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE }, missingBindings: [], missingSecrets: [],
    ports: {
      ...fakes, d1, rateLimits: { RATE_LIMIT: new FakeRateLimit(fakes.clock, 600, 60_000) },
      githubLogin: { authorizeUrl: async () => "https://github.com/login/oauth/authorize?x=1", profile: async () => { throw new Error("unused"); } },
    },
    services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { oidc: oidcConfig({ ENVIRONMENT: "production" }), fetch, cdnOrigin: undefined, siteOrigins: [ORIGIN], ...config },
  };
  const app = createApp(runtime);
  const request = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init);
  return { request, runtime, d1, ports: { d1, clock: runtime.ports.clock, rng: runtime.ports.rng } };
}

export type Harness = ReturnType<typeof setup>;

/** A person who signed up by passkey and chose a handle, as the browser would: the cookie it was given. */
export async function signUp(h: Harness, handle: string) {
  const device = new VirtualAuthenticator();
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    h.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  const start = (await (await post("/api/auth/passkey/signup/options", { "turnstile-unavailable": "1" }, { "x-turnstile-unavailable": "1" })).json()) as { options: Parameters<VirtualAuthenticator["create"]>[0] };
  const finish = await post("/api/auth/passkey/signup/verify", { response: await device.create(start.options, ORIGIN) });
  const cookie = finish.headers.get("set-cookie")!.split(";")[0]!;
  const get = (path: string) => h.request(path, { headers: { cookie } });
  const csrf = async () => ((await (await get("/api/auth/session")).json()) as { csrf: string }).csrf;
  const named = await post("/api/auth/handle", { handle }, { cookie, "x-csrf-token": await csrf(), "idempotency-key": `handle-${handle}-0001` });
  expect(named.status).toBe(200);
  const { rows } = await h.d1.query("select id from users where handle = ?", [handle]);
  return { cookie, userId: String(rows[0]!.id), get };
}

/** The page's visible words: markup, styles and scripts removed. */
export const wordsOf = (html: string): string =>
  html.replace(/<(style|script)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
