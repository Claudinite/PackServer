import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBindings } from "./check-bindings.mjs";
import { TEST_STRINGS } from "./test-strings.mjs";

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
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function run(dir: string): { ok: boolean; out: string } {
  const { problems } = checkBindings(dir);
  return { ok: problems.length === 0, out: problems.map((p) => `check-bindings: ${p}`).join("\n") };
}

function runCli(dir: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("node", [TOOL, dir], { stdio: "pipe" }).toString() };
  } catch (e) {
    const err = e as { status: number; stderr: Buffer };
    return { code: err.status, out: String(err.stderr) };
  }
}

// A cold run parses every source file and the CLI tests start a process, which can pass the 5 s default on a busy runner.
describe("check-bindings", { timeout: 20_000 }, () => {
  it("accepts the repository", () => {
    expect(run(REPO)).toMatchObject({ ok: true });
  });

  it("exits 0 on the repository", () => {
    expect(runCli(REPO).code).toBe(0);
  });

  it("exits 1 with the problem on stderr when one is broken", () => {
    const dir = copyRepo();
    edit(dir, "mcp", (c) => delete c.env.staging.ratelimits);
    expect(runCli(dir)).toMatchObject({ code: 1, out: expect.stringContaining("workers/mcp env.staging: rate limits is []") });
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
    const out = run(dir).out;
    expect(out).toContain("workers/github env.production: workflows is");
    expect(out).toContain("workers/github env.production: this Worker must never hold Workflows");
  });

  it("fails on a Workflows binding on publish, which starts runs only through the validator", () => {
    const dir = copyRepo();
    edit(dir, "publish", (c) => (c.env.staging.workflows = [{ binding: "VALIDATE_PACK", name: "validate-pack-staging", class_name: "ValidatePackWorkflow" }]));
    const out = run(dir).out;
    expect(out).toContain("workers/publish env.staging: workflows is");
    expect(out).toContain("workers/publish env.staging: this Worker must never hold Workflows");
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

  it.each(TEST_STRINGS)("fails on the test string %s in a deployed configuration no set check looks at", (testString) => {
    const dir = copyRepo();
    edit(dir, "mcp", (c) => (c.env.production.vars.NOTE = `x ${testString} y`));
    expect(run(dir).out).toContain(`workers/mcp env.production: test string "${testString}" in a deployed configuration`);
  });

  it("holds the test strings to the list IT-OPS-003 names", () => {
    const section = /### IT-OPS-003[\s\S]*?(?=\n### )/.exec(readFileSync(join(REPO, "docs/testing/operations.md"), "utf8"))![0];
    expect(TEST_STRINGS.filter((s) => !section.includes(s))).toEqual([]);
  });

  it("includes the Turnstile always-pass sitekey", () => {
    expect(TEST_STRINGS).toContain("1x00000000000000000000AA");
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

  it.each([
    ["destructuring", "export const x = (c: { env: Env }) => { const { SESSIONS_KV } = c.env; return SESSIONS_KV; };"],
    ["a renamed destructured name", "export const x = (env: Env) => { const { SESSIONS_KV: kv } = env; return kv; };"],
    ["an alias", "export const x = (c: { env: Env }) => { const e = c.env; return e.SESSIONS_KV; };"],
    ["an alias of an alias", "export const x = (c: { env: Env }) => { const e = c.env; const f = e as Env; return f.SESSIONS_KV; };"],
    ["a line break before the name", "export const x = (env: Env) =>\n  env\n    .SESSIONS_KV;"],
    ["an element access", 'export const x = (env: Env) => env["SESSIONS_KV"];'],
    ["a parameter typed Env", "export const x = ({ SESSIONS_KV }: Env) => SESSIONS_KV;"],
  ])("fails on a binding read through %s", (_name, code) => {
    const dir = copyRepo();
    writeFileSync(join(dir, "workers/web/src/app.ts"), `interface Env { SESSIONS_KV: unknown }\n${code}\n`);
    expect(run(dir).out).toContain("workers/web/src/app.ts: touches binding SESSIONS_KV outside bindings.ts");
  });

  it("does not take a port named like a binding for the binding", () => {
    const dir = copyRepo();
    writeFileSync(join(dir, "workers/web/src/app.ts"), "export const x = (ports: { kv: { SESSIONS_KV: unknown } }) => ports.kv.SESSIONS_KV;\n");
    expect(run(dir).ok).toBe(true);
  });

  it("scans packages for a binding read outside the Cloudflare adapters", () => {
    const dir = copyRepo();
    mkdirSync(join(dir, "packages/http/src"), { recursive: true });
    writeFileSync(join(dir, "packages/http/src/leak.ts"), "export const x = (c: { env: { DB: unknown } }) => c.env.DB;\n");
    expect(run(dir).out).toContain("packages/http/src/leak.ts: touches binding DB outside bindings.ts");
  });

  it("leaves packages/ports/cloudflare free to speak the bindings", () => {
    const dir = copyRepo();
    mkdirSync(join(dir, "packages/ports/cloudflare"), { recursive: true });
    writeFileSync(join(dir, "packages/ports/cloudflare/x.ts"), "export const x = (env: { DB: unknown }) => env.DB;\n");
    expect(run(dir).ok).toBe(true);
  });

  it.each([
    ["a renamed destructure of the holder", "export const f = (c: { env: unknown }) => { const { env: e } = c; return e; };", "destructures `env`"],
    ["a renamed destructured parameter", "export const f = ({ env: x }: { env: unknown }) => x;", "destructures `env`"],
    ["a nested destructure", "export const f = (c: { env: unknown }) => { const { env: { DB } } = c as never; return DB; };", "destructures `env`"],
    ["an assignment alias", "export const f = (c: { env: unknown }) => { let e: unknown; e = c.env; return e; };", "reads `.env`"],
    ["a computed key", 'export const f = (c: { env: Record<string, unknown> }, k: string) => c.env[k];', "reads `.env`"],
    ["a spread", "export const f = (c: { env: object }) => ({ ...c.env });", "reads `.env`"],
    ["Reflect.get", 'export const f = (c: { env: object }) => Reflect.get(c.env, "DB");', "reads `.env`"],
    ["Object.values", "export const f = (c: { env: object }) => Object.values(c.env);", "reads `.env`"],
    ["a parameter type alias", 'import type { Env } from "./bindings";\ntype E = Env;\nexport const f = (x: E) => x;', "imports the Env type"],
  ])("fails on %s outside bindings.ts", (_name, code, message) => {
    const dir = copyRepo();
    writeFileSync(join(dir, "workers/web/src/app.ts"), `${code}\n`);
    expect(run(dir).out).toContain(`workers/web/src/app.ts: ${message} outside bindings.ts`);
  });

  it.each([
    ["an untyped handler parameter", "export default { fetch: (request: Request, e: any) => e.DB };", "workers/web/src/index.ts: hands the handler's env to something other than createRuntime"],
    ["env passed on to the app", 'import { createApp } from "./app";\nexport default { fetch: (request: Request, env: unknown) => createApp({} as never).fetch(request, env) };', "workers/web/src/index.ts: hands the handler's env to something other than createRuntime"],
    ["env kept in a variable", "export default { scheduled: (controller: unknown, env: unknown) => { const kept = env; return kept; } };", "workers/web/src/index.ts: hands the handler's env to something other than createRuntime"],
  ])("fails on %s in index.ts", (_name, code, message) => {
    const dir = copyRepo();
    writeFileSync(join(dir, "workers/web/src/index.ts"), `${code}\n`);
    expect(run(dir).out).toContain(message);
  });

  it("lets a Durable Object class keep its own env but not read a binding off it", () => {
    const dir = copyRepo();
    const file = join(dir, "workers/publish/src/objects.ts");
    const source = readFileSync(file, "utf8");
    writeFileSync(join(dir, "workers/publish/src/more.ts"), 'import { DurableObject } from "cloudflare:workers";\nexport class A extends DurableObject { keep() { return this.env; } }\n');
    expect(run(dir).ok).toBe(true);
    writeFileSync(join(dir, "workers/publish/src/more.ts"), 'import { DurableObject } from "cloudflare:workers";\nexport class A extends DurableObject { read() { return (this.env as never as { DB: unknown }).DB; } }\n');
    expect(run(dir).out).toContain("workers/publish/src/more.ts: touches binding DB outside bindings.ts");
    writeFileSync(join(dir, "workers/publish/src/more.ts"), "export class B { keep() { return (this as never as { env: unknown }).env; } }\n");
    expect(run(dir).out).toContain("workers/publish/src/more.ts: reads `.env` outside bindings.ts");
    expect(source).toContain("DurableObject");
  });

  it("fails on an env import from cloudflare:workers and on a binding type outside bindings.ts", () => {
    const dir = copyRepo();
    writeFileSync(join(dir, "workers/web/src/app.ts"), 'import { env } from "cloudflare:workers";\nexport const db: D1Database = env.DB;\n');
    const out = run(dir).out;
    expect(out).toContain("imports `env` from \"cloudflare:workers\"");
    expect(out).toContain("names the Cloudflare binding type D1Database");
  });

  it.each([
    ["handed to a variable first", "const bucket = env.PACKS_PUBLIC;\n  return { r2: { PACKS_PUBLIC: r2ReadPort(bucket) } };"],
    ["wrapped in the writing port", "return { r2: { PACKS_PUBLIC: r2Port(env.PACKS_PUBLIC) } };"],
    ["passed along raw", "return { r2: { PACKS_PUBLIC: env.PACKS_PUBLIC } };"],
  ])("fails on a read-only bucket %s", (_name, body) => {
    const dir = copyRepo();
    const path = join(dir, "workers/web/src/bindings.ts");
    const source = readFileSync(path, "utf8");
    writeFileSync(path, source.replace(/export function createRuntime/, `export function leak(env: Env) {\n  ${body}\n}\n\nexport function createRuntime`));
    expect(run(dir).out).toContain("workers/web/src/bindings.ts: read-only bucket PACKS_PUBLIC");
  });

  it("fails when a read-only bucket never goes through r2ReadPort", () => {
    const dir = copyRepo();
    const path = join(dir, "workers/mcp/src/bindings.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("r2ReadPort(env.PACKS_PRIVATE)", "undefined as never"));
    expect(run(dir).out).toContain("workers/mcp/src/bindings.ts: read-only bucket PACKS_PRIVATE");
  });

  it("names every test Worker <worker>-test", () => {
    const dir = copyRepo();
    edit(dir, "web", (c) => (c.env.test.name = "web"));
    expect(run(dir).out).toContain('workers/web env.test: name is "web", expected "web-test"');
  });

  it("fails when a test name or a rate-limit namespace equals a deployed one", () => {
    const dir = copyRepo();
    const web = JSON.parse(readFileSync(join(dir, "workers/web/wrangler.jsonc"), "utf8")).env;
    edit(dir, "web", (c) => {
      c.env.test.name = c.env.staging.name;
      c.env.test.ratelimits[0].namespace_id = web.production.ratelimits[0].namespace_id;
    });
    const out = run(dir).out;
    expect(out).toContain('env.test and env.staging share the Worker name "web-staging"');
    expect(out).toContain(`env.test and env.production share the resource "rate limit namespace ${web.production.ratelimits[0].namespace_id}"`);
  });

  it("requires workers_dev: false in env.test", () => {
    const dir = copyRepo();
    edit(dir, "prober", (c) => delete c.env.test.workers_dev);
    expect(run(dir).out).toContain("workers/prober env.test: workers_dev must be false");
  });

  it.each([
    ["an Analytics Engine dataset", "prober", (b: Json) => (b.analytics_engine_datasets[2].dataset = "synthetic_probes"), 'share the resource "dataset synthetic_probes"'],
    ["an R2 bucket", "web", (b: Json) => (b.r2_buckets[0].bucket_name = "packs-public"), 'share the resource "r2 packs-public"'],
    ["a queue", "publish", (b: Json) => (b.queues.producers[0].queue = "notify"), 'share the resource "queue notify"'],
    ["a D1 database", "web", (b: Json) => (b.d1_databases[0].database_name = "registry"), 'share the resource "d1 registry"'],
  ])("fails when env.test shares %s with production", (_name, worker, change, message) => {
    const dir = copyRepo();
    edit(dir, worker, (c) => change(c.env.test));
    expect(run(dir).out).toContain(`env.test and env.production ${message}`);
  });

  it("names the top level <worker>-local, with no routes, so a bare deploy replaces nothing", () => {
    const dir = copyRepo();
    edit(dir, "web", (c) => (c.name = "web"));
    expect(run(dir).out).toContain('workers/web: top-level name is "web", expected "web-local"');
    const routed = copyRepo();
    edit(routed, "web", (c) => ((c.routes = ["registry.claudinite.com/*"]), (c.workers_dev = true)));
    const out = run(routed).out;
    expect(out).toContain("workers/web: the top level must not declare routes");
    expect(out).toContain("workers/web: the top level needs workers_dev: false");
  });

  it("requires a final newline in every wrangler.jsonc", () => {
    const dir = copyRepo();
    const path = join(dir, "workers/admin/wrangler.jsonc");
    writeFileSync(path, readFileSync(path, "utf8").trimEnd());
    expect(run(dir).out).toContain("workers/admin: wrangler.jsonc must end with a newline");
  });

  it("fails when a shared KV namespace has two ids in one environment", () => {
    const dir = copyRepo();
    edit(dir, "publish", (c) => (c.env.production.kv_namespaces[0].id = "00000000000000000000229999999999"));
    expect(run(dir).out).toContain("kv:cache has two ids in env.production");
  });

  it("allows a Durable Object class to import from cloudflare:workers", () => {
    const dir = copyRepo();
    expect(run(dir).ok).toBe(true);
    expect(readFileSync(join(dir, "workers/publish/src/objects.ts"), "utf8")).toContain("cloudflare:workers");
  });
});
