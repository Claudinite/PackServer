import { VirtualAuthenticator } from "@packserver/core/identity/virtual-authenticator";
import { oidcConfig } from "@packserver/core/publishing";
import { migratedD1 } from "@packserver/core/identity/testing";
import { mintToken } from "@packserver/core/tokens";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts, FakeRateLimit } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";

const ORIGIN = "https://registry.example";

function setup() {
  const fakes = createFakePorts({ worker: "web" });
  const { d1 } = migratedD1();
  const runtime: WebRuntime = {
    worker: "web", environment: "test", version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE }, missingBindings: [], missingSecrets: [],
    ports: {
      ...fakes, d1, rateLimits: { RATE_LIMIT: new FakeRateLimit(fakes.clock, 600, 60_000) },
      githubLogin: { authorizeUrl: async () => "", profile: async () => { throw new Error("unused"); } },
    },
    services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { oidc: oidcConfig({ ENVIRONMENT: "production" }), fetch, cdnOrigin: undefined, siteOrigins: [ORIGIN] },
  };
  const app = createApp(runtime);
  const request = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init);
  return { request, runtime, d1 };
}

type Harness = ReturnType<typeof setup>;

/** A person who signed up by passkey, as the browser would: the cookie it was given and the codes it was shown. */
async function signUp(h: Harness, handle?: string) {
  const device = new VirtualAuthenticator();
  const turnstile = { "turnstile-unavailable": "1" };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    h.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  const start = (await (await post("/api/auth/passkey/signup/options", turnstile, { "x-turnstile-unavailable": "1" })).json()) as { options: Parameters<VirtualAuthenticator["create"]>[0] };
  const finish = await post("/api/auth/passkey/signup/verify", { response: await device.create(start.options, ORIGIN) });
  const done = (await finish.json()) as { recovery_codes: string[] };
  const cookie = finish.headers.get("set-cookie")!.split(";")[0]!;
  const get = (path: string) => h.request(path, { headers: { cookie } });
  const csrf = async () => ((await (await get("/api/auth/session")).json()) as { csrf: string }).csrf;
  if (handle) {
    const res = await post("/api/auth/handle", { handle }, { cookie, "x-csrf-token": await csrf(), "idempotency-key": "handle-key-0001" });
    expect(res.status).toBe(200);
  }
  return { cookie, codes: done.recovery_codes, get, post, csrf };
}

describe("sign-in page (REQ-ACC-001)", () => {
  it("offers a passkey first and GitHub, and no other provider", async () => {
    const res = await setup().request("/signin?next=/dashboard");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(html.indexOf("Sign in with a passkey")).toBeGreaterThan(-1);
    expect(html.indexOf("Sign in with a passkey")).toBeLessThan(html.indexOf("Continue with GitHub"));
    expect(html).toMatch(/<form method="post" action="\/api\/auth\/github">/);
    expect(html).toContain('name="next" value="/dashboard"');
    expect(html).not.toMatch(/google|apple|one-time code|magic link|authenticator app|totp/i);
  });

  it("falls back to GitHub where WebAuthn is missing, with the passkey group shown only by script", async () => {
    const html = await (await setup().request("/signin")).text();
    expect(html).toMatch(/id="passkeys"[^>]*hidden/);
    expect(html).toContain("This browser cannot use passkeys. Continue with GitHub.");
  });

  it("keeps a return target on this site", async () => {
    const html = await (await setup().request("/signin?next=//evil.example/x")).text();
    expect(html).toContain('name="next" value="/"');
  });

  it("asks a new account for its handle and sends one who has it onward", async () => {
    const h = setup();
    const person = await signUp(h);
    const step = await person.get("/signin?step=handle&next=/dashboard");
    expect(await step.text()).toContain("Choose a handle");
    expect((await h.request("/signin?step=handle")).status).toBe(303);

    await person.post("/api/auth/handle", { handle: "ann" }, { cookie: person.cookie, "x-csrf-token": await person.csrf(), "idempotency-key": "handle-key-0002" });
    const onward = await person.get("/signin?next=/dashboard");
    expect([onward.status, onward.headers.get("location")]).toEqual([303, "/dashboard"]);
  });
});

describe("account pages", () => {
  it("send a signed-out visitor to sign in and back, and a handle-less account to choose one", async () => {
    const h = setup();
    const out = await h.request("/account/security?step=enrol");
    expect([out.status, out.headers.get("location")]).toEqual([303, `/signin?next=${encodeURIComponent("/account/security?step=enrol")}`]);
    const person = await signUp(h);
    const res = await person.get("/account");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/signin?step=handle");
  });

  it("show the account and a sign-out", async () => {
    const h = setup();
    const person = await signUp(h, "ann");
    const html = await (await person.get("/account")).text();
    expect(html).toContain("@ann");
    expect(html).toContain('href="/account/security"');
    expect(html).toContain('data-do="sign-out"');
    expect(html).toMatch(/<a href="\/account">Account<\/a>/);
  });
});

describe("security page (REQ-ACC-006, REQ-ACC-010, REQ-ACC-020, REQ-AUDIT-002, REQ-PUB-012)", () => {
  it("lists the passkey with its last use, sessions, and history, each action behind the one dialog", async () => {
    const h = setup();
    const person = await signUp(h, "ann");
    const res = await person.get("/account/security");
    const html = await res.text();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toMatch(/Passkey <span class="when">added \d{4}-\d{2}-\d{2} · last used (never|\d{4}-\d{2}-\d{2})/);
    expect(html).toMatch(/Sessions · 1/);
    expect(html).toContain("this device");
    expect(html).toContain('data-do="revoke-session"');
    expect(html).toContain("Signed in");
    expect(html).toContain("in the last 90 days");
    for (const act of ["enrol", "remove-passkey", "regenerate", "link-github", "delete-account"]) expect(html).toContain(`data-do="${act}"`);
    expect((html.match(/<dialog id="ps-dialog"/g) ?? []).length).toBe(1);
    expect(html).toContain("Use a recovery code instead");
    expect(html).not.toMatch(/totp|authenticator app|one-time code/i);
    for (const tag of html.match(/<script[^>]*>/g) ?? []) expect(tag).toMatch(/^<script nonce="[0-9a-f]+">$/);
  });

  it("reminds about the recovery codes until they are saved, and then no longer", async () => {
    const h = setup();
    const person = await signUp(h, "ann");
    expect(person.codes).toHaveLength(10);
    const before = await (await person.get("/account/security")).text();
    expect(before).toContain("Your recovery codes are not confirmed as saved.");
    for (const code of person.codes) expect(before).not.toContain(code);

    const saved = await person.post("/api/auth/recovery/saved", {}, { cookie: person.cookie, "x-csrf-token": await person.csrf() });
    expect(saved.status).toBe(200);
    const after = await (await person.get("/account/security")).text();
    expect(after).not.toContain("not confirmed as saved");
    expect(after).toContain("10 codes left");
    for (const code of person.codes) expect(after).not.toContain(code);
  });

  it("puts the passkey prompt first after a recovery sign-in with no factor", async () => {
    const h = setup();
    const person = await signUp(h, "ann");
    await h.d1.query("delete from credentials where user_id = (select id from users where handle = 'ann')");
    const html = await (await person.get("/account/security?step=enrol")).text();
    expect(html).toContain("Add a passkey. Publishing and managing packs need one.");
    expect(html).toContain('data-first="1"');
    expect(html).toContain("Add a passkey to create read tokens.");
  });

  it("lists read tokens with their last use and never a token value, and offers the mint form to an account with a passkey", async () => {
    const h = setup();
    const person = await signUp(h, "ann");
    const { rows } = await h.d1.query("select id from users where handle = 'ann'");
    const minted = await mintToken({ d1: h.d1, clock: h.runtime.ports.clock, rng: h.runtime.ports.rng }, { userId: String(rows[0]!.id), scope: "ann", label: "ci" });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const html = await (await person.get("/account/security")).text();
    expect(html).toContain("Read tokens · 1");
    expect(html).toContain(minted.view.hint);
    expect(html).toContain("last used never");
    expect(html).not.toContain(minted.token);
    expect(html).toContain('id="mint-token"');
    expect(html).toContain('data-do="revoke-token"');
    expect(html).toContain("never publishes");
  });
});
