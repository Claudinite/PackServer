import { describe, expect, it } from "vitest";
import { FIXTURES, main, packFixture } from "./publish-canary.mjs";

const ENV = { PACKSERVER_OIDC_TOKEN: "oidc-token-value", PACKSERVER_BASE_URL: "https://registry.example", GITHUB_JOB: "canary" };

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

/** The registry's publish API as far as the script talks to it. */
function registry({ exists = false, verdict = "pass", runsUnfinished = 0 } = {}) {
  const calls = [];
  const puts = [];
  let polls = 0;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname, auth: init.headers?.authorization, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    if (u.host === "storage.example") return (puts.push(init.body), { ok: true, status: 200 });
    if (u.pathname === "/api/oidc/exchange") return exists ? json(409, { reason: "exists", message: "already exists" }) : json(200, { credential: "psu_secret", expires_at: "x" });
    if (u.pathname.endsWith("/upload-url")) return json(200, { method: "PUT", url: "https://storage.example/staging/key", headers: { "x-amz-checksum": "c" } });
    if (u.pathname.endsWith("/uploaded")) return json(200, { size_bytes: 1 });
    if (u.pathname.startsWith("/api/publish/runs/")) return json(200, { run_id: "r1", status: ++polls > runsUnfinished ? "finished" : "running", verdict: polls > runsUnfinished ? verdict : null });
    return json(202, { run_id: "r1", status: "queued", verdict: null });
  };
  return { fetchFn, calls, puts };
}

const run = async (r, argv = [], env = ENV) => {
  const lines = [];
  const code = await main(argv, env, { fetch: r.fetchFn, log: (l) => lines.push(l), sleep: async () => {}, pollMs: 0, maxPolls: 5 });
  return { code, lines };
};

describe("publish-canary", () => {
  it("packs every fixture to the same bytes every time, so the prober can pin its hash", async () => {
    const [a, b] = [await packFixture(FIXTURES[0]), await packFixture(FIXTURES[0])];
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exchanges the token, uploads the canonical archive once and waits for the verdict", async () => {
    const r = registry({ runsUnfinished: 2 });
    const { code, lines } = await run(r);
    const expected = await packFixture(FIXTURES[0]);
    expect(code).toBe(0);
    expect(lines).toEqual([`@packserver-canary/notes@1.0.0: run r1 pass, sha256 ${expected.sha256}`]);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/oidc/exchange",
      "POST /api/publish/@packserver-canary/notes/1.0.0/upload-url",
      "PUT /staging/key",
      "POST /api/publish/@packserver-canary/notes/1.0.0/uploaded",
      "POST /api/publish/@packserver-canary/notes/1.0.0",
      "GET /api/publish/runs/r1",
      "GET /api/publish/runs/r1",
      "GET /api/publish/runs/r1",
    ]);
    expect(r.calls[0].body).toMatchObject({ token: "oidc-token-value", pack: "@packserver-canary/notes", version: "1.0.0", job: "canary" });
    expect(r.calls[4].body).toEqual({ sha256: expected.sha256 });
    expect(r.puts).toHaveLength(1);
  });

  it("never prints the token or the credential", async () => {
    const { lines } = await run(registry());
    expect(lines.join("\n")).not.toMatch(/oidc-token-value|psu_secret/);
  });

  it("leaves a fixture that is already published alone", async () => {
    const r = registry({ exists: true });
    const { code, lines } = await run(r);
    expect(code).toBe(0);
    expect(lines).toEqual(["@packserver-canary/notes@1.0.0: already published"]);
    expect(r.puts).toEqual([]);
  });

  it.each(["fail", "error", "hold"])("exits non-zero when the verdict is %s", async (verdict) => {
    expect((await run(registry({ verdict }))).code).toBe(1);
  });

  it("asks the runner for a token for the registry's audience when none is given", async () => {
    const r = registry();
    const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-bearer", PACKSERVER_BASE_URL: ENV.PACKSERVER_BASE_URL };
    const inner = r.fetchFn;
    const asked = [];
    r.fetchFn = async (url, init) => {
      if (new URL(url).host === "runner.example") return (asked.push([String(url), init.headers.authorization]), json(200, { value: "minted" }));
      return inner(url, init);
    };
    expect((await run(r, [], env)).code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0][0]).toMatch(/audience=/);
    expect(asked[0][1]).toBe("Bearer runner-bearer");
    expect(r.calls[0].body.token).toBe("minted");
  });

  it("says what is missing when there is no token, and names an unknown fixture", async () => {
    const none = await run(registry(), [], { PACKSERVER_BASE_URL: ENV.PACKSERVER_BASE_URL });
    expect(none.code).toBe(1);
    expect(none.lines[0]).toMatch(/no OIDC token/);
    expect(await run(registry(), ["--pack", "@packserver-canary/ghost"])).toEqual({ code: 1, lines: ["no fixture named @packserver-canary/ghost"] });
  });
});
