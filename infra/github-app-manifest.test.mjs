import { describe, expect, it } from "vitest";
import { buildManifest, main, renderForm } from "./github-app-manifest.mjs";

const ENV = { CF_BOOTSTRAP_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" };

function fakes({ existing = [], accounts = [{ id: "acct" }], failWrites = 0, failProbe = false, loseReplyOn, slug = "claudinite-packs" } = {}) {
  const created = [];
  const deleted = [];
  const calls = [];
  let writeFailuresLeft = failWrites;
  let replyLost = false;
  const fetch = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith("/client/v4/accounts")) return json(200, { success: true, result: accounts });
    if (url.endsWith("/secrets_store/stores")) return json(200, { success: true, result: [{ id: "s" }] });
    if (url.includes("/secrets?page=")) {
      const names = [...existing, ...created.filter((c) => !deleted.includes(c.name)).map((c) => c.name)];
      return json(200, { success: true, result: names.map((name) => ({ name, id: `id-${name}` })), result_info: { total_pages: 1 } });
    }
    if (init.method === "DELETE") {
      deleted.push(url.split("/").pop().replace("id-", ""));
      return json(200, { success: true, result: {} });
    }
    if (init.method === "POST" && url.includes("/secrets_store/")) {
      const item = JSON.parse(init.body)[0];
      const isProbe = item.name.startsWith("PACKSERVER_WRITE_PROBE_");
      if (isProbe && failProbe) return json(403, { success: false, errors: [{ code: 10000, message: "forbidden" }] });
      if (!isProbe && writeFailuresLeft > 0) {
        writeFailuresLeft--;
        return json(503, { success: false, errors: [{ code: 1, message: "unavailable" }] });
      }
      created.push(item);
      if (item.name === loseReplyOn && !replyLost) {
        replyLost = true;
        throw new Error("connection reset after the write");
      }
      return json(200, { success: true, result: [] });
    }
    if (url.includes("/app-manifests/") && url.endsWith("/conversions")) {
      expect(init.headers.authorization).toBe("Bearer gh-token");
      return json(201, { id: 42, slug, client_id: "Iv1.abc", client_secret: "SECRET-cs-9", webhook_secret: "SECRET-ws-9", pem: "-----BEGIN-----" });
    }
    return json(404, {});
  };
  return { fetch, created, deleted, calls };
}

async function drive(argv, deps) {
  const out = [];
  const err = [];
  let opened;
  const opener = (url) => {
    opened = url;
  };
  const done = main(argv, ENV, { out: (s) => out.push(s), err: (s) => err.push(s), openBrowser: opener, sleep: async () => {}, prompt: async () => "", ghToken: async () => "gh-token", state: () => "state123", ...deps });
  return { done, out, err, getOpened: () => opened };
}

const waitFor = async (fn) => {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out in test");
};

describe("manifest", () => {
  it("matches the T-012 acceptance shape", () => {
    const m = buildManifest("production", 5555);
    expect(m.name).toBe("Claudinite Packs");
    expect(m.hook_attributes.url).toBe("https://registry.claudinite.com/hooks/github");
    expect(m.redirect_url).toBe("http://127.0.0.1:5555/callback");
    expect(m.callback_urls).toEqual(["https://registry.claudinite.com/api/auth/github/callback"]);
    expect(m.public).toBe(true);
    expect(m.request_oauth_on_install).toBe(true);
    expect(m.default_events).toEqual(["installation", "installation_repositories", "issues"]);
    expect(m.default_permissions).toEqual({ metadata: "read", members: "read", issues: "read", contents: "read", email_addresses: "read" });
    expect(m.default_events).not.toContain("push");
  });

  it("uses staging names and hosts", () => {
    const m = buildManifest("staging", 1);
    expect(m.name).toBe("Claudinite Packs (staging)");
    expect(m.hook_attributes.url).toBe("https://registry-staging.claudinite.com/hooks/github");
  });

  it("renders an auto-submitting form carrying the state and an escaped manifest", () => {
    const html = renderForm(buildManifest("production", 1), "abc");
    expect(html).toContain('action="https://github.com/organizations/Claudinite/settings/apps/new?state=abc"');
    expect(html).toContain('name="manifest"');
    expect(html).toContain(".submit()");
    expect(html).not.toContain('value="{"');
  });
});

describe("github-app-manifest.mjs", () => {
  it("prints usage on --help, refuses without --env or credentials", async () => {
    const out = [];
    expect(await main(["--help"], {}, { out: (s) => out.push(s) })).toBe(0);
    expect(out.join()).toContain("Usage: node infra/github-app-manifest.mjs");
    const err = [];
    expect(await main([], ENV, { err: (s) => err.push(s) })).toBe(2);
    expect(await main(["--env", "staging"], {}, { err: (s) => err.push(s), fetch: fakes().fetch })).toBe(2);
    expect(err.join()).toContain("CF_BOOTSTRAP_TOKEN");
  });

  it("dry-run prints the manifest with no network", async () => {
    const f = fakes();
    const out = [];
    const code = await main(["--env", "staging", "--dry-run"], {}, { out: (s) => out.push(s), fetch: f.fetch });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Claudinite Packs (staging)");
    expect(out.join("\n")).toContain("STAGING_GITHUB_APP_PRIVATE_KEY");
    expect(f.calls).toEqual([]);
  });

  it("serves the form, rejects a wrong state, then converts and stores on the right one", async () => {
    const f = fakes();
    const d = await drive(["--env", "production"], { fetch: f.fetch });
    const base = (await waitFor(() => d.getOpened())).replace(/\/$/, "");

    const form = await (await globalThis.fetch(`${base}/`)).text();
    expect(form).toContain(`http://127.0.0.1:${new URL(base).port}/callback`);

    const bad = await globalThis.fetch(`${base}/callback?code=c1&state=wrong`);
    expect(bad.status).toBe(400);
    expect(f.calls.some((c) => c.includes("conversions"))).toBe(false);

    const ok = await globalThis.fetch(`${base}/callback?code=c1&state=state123`);
    expect(ok.status).toBe(200);
    expect(await d.done).toBe(0);

    expect(f.created.map((c) => c.name).filter((n) => !n.startsWith("PACKSERVER_WRITE_PROBE_"))).toEqual([
      "GITHUB_APP_ID",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
    ]);
    expect(f.created.find((c) => c.name === "GITHUB_APP_ID").value).toBe("42");
    expect(f.deleted).toHaveLength(1);
    const shown = d.out.join("\n") + d.err.join("\n");
    for (const secret of ["SECRET-cs-9", "SECRET-ws-9", "-----BEGIN-----", "Iv1.abc"]) expect(shown).not.toContain(secret);
    expect(shown).toContain("https://github.com/apps/claudinite-packs/installations/new");
  });

  it("refuses to register a second App when the secrets exist", async () => {
    const f = fakes({ existing: ["STAGING_GITHUB_APP_ID"] });
    const d = await drive(["--env", "staging"], { fetch: f.fetch });
    expect(await d.done).toBe(1);
    expect(d.getOpened()).toBeUndefined();
    expect(f.created).toEqual([]);
  });

  it("proves write access before opening the browser and stops if it cannot write", async () => {
    const f = fakes({ failProbe: true });
    const d = await drive(["--env", "production"], { fetch: f.fetch });
    expect(await d.done).toBe(1);
    expect(d.getOpened()).toBeUndefined();
  });

  it("looks the account up from the token, and exits 2 when it sees several", async () => {
    const f = fakes({ accounts: [{ id: "a" }, { id: "b" }] });
    const err = [];
    expect(await main(["--env", "staging"], { CF_BOOTSTRAP_TOKEN: "t" }, { fetch: f.fetch, err: (s) => err.push(s) })).toBe(2);
    expect(err.join()).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("keeps values in memory and retries the remaining names when Enter is pressed", async () => {
    const f = fakes({ failWrites: 4 });
    const prompts = [];
    const d = await drive(["--env", "production"], { fetch: f.fetch, prompt: async (q) => (prompts.push(q), "") });
    const base = (await waitFor(() => d.getOpened())).replace(/\/$/, "");
    await globalThis.fetch(`${base}/callback?code=c1&state=state123`);
    expect(await d.done).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("GITHUB_APP_ID");
    expect(f.created.filter((c) => c.name.startsWith("GITHUB_APP_"))).toHaveLength(5);
    expect(prompts.join() + d.out.join() + d.err.join()).not.toContain("SECRET-cs-9");
  });

  it("on abort says to regenerate the secrets in the App settings", async () => {
    const f = fakes({ failWrites: 1000 });
    const d = await drive(["--env", "production"], { fetch: f.fetch, prompt: async () => "abort" });
    const base = (await waitFor(() => d.getOpened())).replace(/\/$/, "");
    await globalThis.fetch(`${base}/callback?code=c1&state=state123`);
    expect(await d.done).toBe(1);
    const text = d.err.join("\n");
    expect(text).toContain("regenerate");
    expect(text).toContain("settings/apps/claudinite-packs");
    expect(text).not.toContain("SECRET-cs-9");
  });

  it("rejects a conversion response without a usable slug", async () => {
    const f = fakes({ slug: "../evil" });
    const d = await drive(["--env", "production"], { fetch: f.fetch });
    const base = (await waitFor(() => d.getOpened())).replace(/\/$/, "");
    await globalThis.fetch(`${base}/callback?code=c1&state=state123`);
    expect(await d.done).toBe(1);
    expect(d.out.join()).not.toContain("installations/new");
    expect(f.created.filter((c) => c.name.startsWith("GITHUB_APP_"))).toEqual([]);
  });

  it("answers only requests whose Host is the loopback origin", async () => {
    const f = fakes();
    const d = await drive(["--env", "production"], { fetch: f.fetch });
    const base = (await waitFor(() => d.getOpened())).replace(/\/$/, "");
    const { request } = await import("node:http");
    const status = await new Promise((resolve, reject) => {
      const req = request(`${base}/`, { headers: { host: "evil.example" } }, (res) => (res.resume(), resolve(res.statusCode)));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
    await globalThis.fetch(`${base}/callback?code=c1&state=state123`);
    expect(await d.done).toBe(0);
  });

  it("does not recreate or report as failed a write whose reply was lost", async () => {
    const f = fakes({ loseReplyOn: "GITHUB_APP_CLIENT_SECRET" });
    const d = await drive(["--env", "production"], { fetch: f.fetch, prompt: async () => { throw new Error("unexpected prompt"); } });
    const base = (await waitFor(() => d.getOpened())).replace(/\/$/, "");
    await globalThis.fetch(`${base}/callback?code=c1&state=state123`);
    expect(await d.done).toBe(0);
    expect(f.created.filter((c) => c.name === "GITHUB_APP_CLIENT_SECRET")).toHaveLength(1);
  });

  it("drops names that already exist before a prompted retry round", async () => {
    const f = fakes({ failWrites: 4, loseReplyOn: "GITHUB_APP_ID" });
    const prompts = [];
    const d = await drive(["--env", "production"], { fetch: f.fetch, prompt: async (q) => (prompts.push(q), "") });
    const base = (await waitFor(() => d.getOpened())).replace(/\/$/, "");
    await globalThis.fetch(`${base}/callback?code=c1&state=state123`);
    expect(await d.done).toBe(0);
    expect(f.created.filter((c) => c.name === "GITHUB_APP_ID").length).toBe(1);
  });

  it("ends with the regeneration guidance when stdin is closed or not a terminal", async () => {
    for (const prompt of [async () => { throw new Error("stdin is not a terminal"); }, async () => null]) {
      const f = fakes({ failWrites: 1000 });
      const d = await drive(["--env", "production"], { fetch: f.fetch, prompt });
      const base = (await waitFor(() => d.getOpened())).replace(/\/$/, "");
      await globalThis.fetch(`${base}/callback?code=c1&state=state123`);
      expect(await d.done).toBe(1);
      expect(d.err.join("\n")).toContain("regenerate");
      expect(d.err.join("\n")).not.toContain("failed: ");
    }
  });
});
