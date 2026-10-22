import { describe, expect, it } from "vitest";
import { buildManifest, main, renderForm } from "./github-app-manifest.mjs";

const ENV = { CF_BOOTSTRAP_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" };

function fakes({ existing = [] } = {}) {
  const created = [];
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith("/secrets_store/stores")) return json(200, { success: true, result: [{ id: "s" }] });
    if (url.includes("/secrets?page=")) return json(200, { success: true, result: existing.map((name) => ({ name })), result_info: { total_pages: 1 } });
    if (init.method === "POST" && url.includes("/secrets_store/")) {
      created.push(JSON.parse(init.body)[0]);
      return json(200, { success: true, result: [] });
    }
    if (url.includes("/app-manifests/") && url.endsWith("/conversions")) {
      expect(init.headers.authorization).toBe("Bearer gh-token");
      return json(201, { id: 42, slug: "claudinite-packs", client_id: "Iv1.abc", client_secret: "SECRET-cs-9", webhook_secret: "SECRET-ws-9", pem: "-----BEGIN-----" });
    }
    return json(404, {});
  };
  return { fetch, created, calls };
}

async function drive(argv, deps) {
  const out = [];
  const err = [];
  let opened;
  const opener = (url) => {
    opened = url;
  };
  const done = main(argv, ENV, { out: (s) => out.push(s), err: (s) => err.push(s), openBrowser: opener, ghToken: async () => "gh-token", state: () => "state123", ...deps });
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
    expect(m.default_permissions).toEqual({ metadata: "read", members: "read", issues: "read", contents: "read", emails: "read" });
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
    expect(await main(["--env", "staging"], {}, { err: (s) => err.push(s) })).toBe(2);
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

    expect(f.created.map((c) => c.name)).toEqual([
      "GITHUB_APP_ID",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
    ]);
    expect(f.created[0].value).toBe("42");
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
});
