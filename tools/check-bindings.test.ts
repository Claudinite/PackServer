import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const TOOL = join(REPO, "tools/check-bindings.mjs");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function copyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bindings-"));
  dirs.push(dir);
  cpSync(join(REPO, "packages/ports/trust-table.json"), join(dir, "packages/ports/trust-table.json"), { recursive: true });
  cpSync(join(REPO, "workers"), join(dir, "workers"), {
    recursive: true,
    filter: (src) => !/node_modules|\.wrangler|\/test(\/|$)/.test(src),
  });
  return dir;
}

// The tests reach into arbitrary paths of a wrangler config to break one rule at a time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
function edit(dir: string, worker: string, change: (config: Json) => void): void {
  const path = join(dir, "workers", worker, "wrangler.jsonc");
  const config = JSON.parse(readFileSync(path, "utf8")) as Json;
  change(config);
  writeFileSync(path, JSON.stringify(config, null, 2));
}

function run(dir: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("node", [TOOL, dir], { stdio: "pipe" }).toString() };
  } catch (e) {
    return { ok: false, out: String((e as { stderr: Buffer }).stderr) };
  }
}

describe("check-bindings", () => {
  it("accepts the repository", () => {
    expect(run(REPO)).toMatchObject({ ok: true });
  });

  it("fails on a binding the trust table does not give the Worker", () => {
    const dir = copyRepo();
    edit(dir, "web", (c) => (c.env.production.kv_namespaces = [...c.env.production.kv_namespaces, { binding: "OAUTH_KV", id: "1" }]));
    expect(run(dir).out).toContain("workers/web env.production: KV namespaces is");
  });

  it("fails on a missing binding in only one environment", () => {
    const dir = copyRepo();
    edit(dir, "mcp", (c) => delete c.env.staging.ratelimits);
    expect(run(dir).out).toContain("workers/mcp env.staging: rate limits is []");
  });

  it("fails on a Workflows binding where the trust table forbids one", () => {
    const dir = copyRepo();
    edit(dir, "github", (c) => (c.env.production.workflows = [{ binding: "VALIDATE_PACK", name: "validate-pack", class_name: "ValidatePackWorkflow" }]));
    expect(run(dir).out).toContain("workers/github env.production: this Worker must never hold Workflows");
  });

  it("fails on a bucket binding to audit-log", () => {
    const dir = copyRepo();
    edit(dir, "admin", (c) => c.env.production.r2_buckets.push({ binding: "OPS_BUCKET", bucket_name: "audit-log" }));
    expect(run(dir).out).toContain("no Worker has a binding to audit-log");
  });

  it("fails on the signing key anywhere but the validator", () => {
    const dir = copyRepo();
    edit(dir, "web", (c) => c.env.production.secrets_store_secrets.push({ binding: "SIGNING_KEY_ACTIVE", store_id: "0", secret_name: "x" }));
    expect(run(dir).out).toContain("only the validator holds the signing key");
  });

  it("fails on a workers.dev route for the admin Worker", () => {
    const dir = copyRepo();
    edit(dir, "admin", (c) => (c.env.production.workers_dev = true));
    expect(run(dir).out).toContain("workers/admin env.production: workers_dev must be false");
  });

  it("fails on a public route for the validator", () => {
    const dir = copyRepo();
    edit(dir, "validator", (c) => c.env.production.routes.push({ pattern: "registry.claudinite.com/*", zone_name: "claudinite.com" }));
    expect(run(dir).out).toContain("validator has no public route");
  });

  it("fails when staging names a production resource", () => {
    const dir = copyRepo();
    edit(dir, "web", (c) => (c.env.staging.r2_buckets[0].bucket_name = "packs-public"));
    expect(run(dir).out).toMatch(/env\.staging and env\.production share the resource "r2 packs-public"/);
  });

  it("fails when staging reuses a production id", () => {
    const dir = copyRepo();
    const production = JSON.parse(readFileSync(join(dir, "workers/web/wrangler.jsonc"), "utf8")).env.production.d1_databases[0].database_id;
    for (const w of ["web", "mcp", "publish", "github", "validator", "admin"]) edit(dir, w, (c) => (c.env.staging.d1_databases[0].database_id = production));
    expect(run(dir).out).toContain(`share the resource "d1 id ${production}"`);
  });

  it("fails when one resource has two ids in an environment", () => {
    const dir = copyRepo();
    edit(dir, "web", (c) => (c.env.production.d1_databases[0].database_id = "00000000-0000-0000-0000-999999999999"));
    expect(run(dir).out).toContain("d1:registry has two ids in env.production");
  });

  it("fails on a test-only string in a deployed environment", () => {
    const dir = copyRepo();
    edit(dir, "mcp", (c) => (c.env.production.services = [{ binding: "AI", service: "fake-ai" }]));
    expect(run(dir).out).toContain('test string "fake-" in a deployed configuration');
  });

  it("fails on a secret given as a plain var outside env.test", () => {
    const dir = copyRepo();
    edit(dir, "web", (c) => (c.env.staging.vars.TURNSTILE_SECRET = "x"));
    expect(run(dir).out).toContain("secret TURNSTILE_SECRET must not be a plain var outside env.test");
  });

  it("fails on a binding read outside bindings.ts", () => {
    const dir = copyRepo();
    writeFileSync(join(dir, "workers/web/src/app.ts"), 'export const x = (env: unknown) => (env as any).SESSIONS_KV;\n');
    expect(run(dir).out).toContain("workers/web/src/app.ts: touches binding SESSIONS_KV outside bindings.ts");
  });

  it("fails on an env import from cloudflare:workers and on a binding type outside bindings.ts", () => {
    const dir = copyRepo();
    writeFileSync(join(dir, "workers/web/src/app.ts"), 'import { env } from "cloudflare:workers";\nexport const db: D1Database = env.DB;\n');
    const out = run(dir).out;
    expect(out).toContain("imports `env` from \"cloudflare:workers\"");
    expect(out).toContain("names the Cloudflare binding type D1Database");
  });

  it("allows a Durable Object class to import from cloudflare:workers", () => {
    const dir = copyRepo();
    expect(run(dir).ok).toBe(true);
    expect(readFileSync(join(dir, "workers/publish/src/objects.ts"), "utf8")).toContain("cloudflare:workers");
  });
});
