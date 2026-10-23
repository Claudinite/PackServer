import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGithubApp, GITHUB_TEST_APP_ID, GITHUB_TEST_WEBHOOK_SECRET } from "../fakes/github-app";
import { REPO_ROOT } from "../root";

const call = (app: FakeGithubApp, method: string, path: string, headers: Record<string, string> = {}) =>
  app.handler()(new Request(`https://api.github.com${path}`, { method, headers }));

describe("the fake GitHub App", () => {
  it("refuses and records every request that would write, and nothing else", async () => {
    const app = new FakeGithubApp();
    for (const [method, path] of [["POST", "/repos/acme/packs/issues"], ["PUT", "/repos/acme/packs/contents/x"], ["PATCH", "/repos/acme/packs/issues/1"], ["DELETE", "/repos/acme/packs"], ["POST", "/repos/acme/packs/statuses/abc"]] as const) {
      expect((await call(app, method, path))?.status).toBe(403);
    }
    await call(app, "GET", "/repos/acme/packs");
    await call(app, "POST", "/app/installations/5/access_tokens");
    expect(app.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /repos/acme/packs/issues",
      "PUT /repos/acme/packs/contents/x",
      "PATCH /repos/acme/packs/issues/1",
      "DELETE /repos/acme/packs",
      "POST /repos/acme/packs/statuses/abc",
    ]);
  });

  it("serves a host only if it is api.github.com", () => {
    expect(new FakeGithubApp().handler()(new Request("https://example.com/"))).toBeUndefined();
  });

  it("rejects a token it did not mint", async () => {
    const app = new FakeGithubApp();
    expect((await call(app, "GET", "/repositories/1", { authorization: "Bearer ghs_forged" }))?.status).toBe(401);
    expect((await call(app, "GET", "/app/installations", { authorization: "Bearer a.b.c" }))?.status).toBe(401);
  });

  it("signs deliveries with the secret and App id in the GitHub Worker's env.test", () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "workers/github/wrangler.jsonc"), "utf8")) as { env: { test: { vars: Record<string, string> } } };
    expect(config.env.test.vars.GITHUB_WEBHOOK_SECRET).toBe(GITHUB_TEST_WEBHOOK_SECRET);
    expect(config.env.test.vars.GITHUB_APP_ID).toBe(GITHUB_TEST_APP_ID);
  });
});
