import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIds, checkIds, main } from "./apply-ids.mjs";
import { readConfigs } from "./lib/plan.mjs";

const REPO = join(import.meta.dirname, "..");

function copyRepo() {
  const root = mkdtempSync(join(tmpdir(), "ids-"));
  cpSync(join(REPO, "workers"), join(root, "workers"), { recursive: true, filter: (p) => !p.includes("node_modules") });
  mkdirSync(join(root, "packages", "ports"), { recursive: true });
  cpSync(join(REPO, "packages", "ports", "trust-table.json"), join(root, "packages", "ports", "trust-table.json"));
  mkdirSync(join(root, "infra"));
  return root;
}

const resources = (env, n) => ({
  secrets_store_id: `store-${env}`,
  d1: { [env === "staging" ? "registry-staging" : "registry"]: { id: `d1-${env}` } },
  kv: Object.fromEntries(["sessions", "oauth", "cache", "gates"].map((k) => [env === "staging" ? `${k}-staging` : k, { id: `kv-${env}-${k}-${n}` }])),
});

describe("the repository's own configs", () => {
  it("share no id between test, staging and production", () => {
    expect(checkIds({ resourcesDir: mkdtempSync(join(tmpdir(), "none-")) })).toEqual([]);
  });
});

describe("apply", () => {
  it("rewrites only the named env's ids and keeps the file otherwise intact", () => {
    const root = copyRepo();
    for (const env of ["staging", "production"]) writeFileSync(join(root, "infra", `resources.${env}.json`), JSON.stringify(resources(env, 1)));
    const before = Object.fromEntries(readConfigs(root).map((c) => [c.path, readFileSync(c.path, "utf8")]));
    expect(applyIds("staging", { root })).toBeGreaterThan(0);
    for (const { path, config } of readConfigs(root)) {
      const prod = JSON.stringify(config.env.production);
      expect(prod).toBe(JSON.stringify(JSON.parse(before[path]).env.production));
      expect(JSON.stringify(config.env.test)).toBe(JSON.stringify(JSON.parse(before[path]).env.test));
    }
    const web = readConfigs(root).find((c) => c.worker === "web").config.env.staging;
    expect(web.d1_databases[0].database_id).toBe("d1-staging");
    expect(web.kv_namespaces.map((k) => k.id)).toEqual(["kv-staging-sessions-1", "kv-staging-cache-1"]);
    expect(web.secrets_store_secrets.every((s) => s.store_id === "store-staging")).toBe(true);
  });

  it("refuses when a needed id is missing", () => {
    const root = copyRepo();
    const r = resources("staging", 1);
    delete r.kv["gates-staging"];
    writeFileSync(join(root, "infra", "resources.staging.json"), JSON.stringify(r));
    expect(() => applyIds("staging", { root })).toThrow(/judge: kv GATES_KV/);
  });

  it("refuses without a resources file", () => {
    expect(() => applyIds("staging", { root: copyRepo() })).toThrow(/provision\.mjs --env staging/);
  });
});

describe("audit endpoint", () => {
  it("takes the account id into its host and keeps its path", () => {
    const root = copyRepo();
    const p = join(root, "workers", "admin", "wrangler.jsonc");
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    cfg.env.staging.vars.AUDIT_S3_ENDPOINT = "https://ACCOUNT_ID.r2.cloudflarestorage.com/audit-log-staging";
    cfg.env.production.vars.AUDIT_S3_ENDPOINT = "https://ACCOUNT_ID.r2.cloudflarestorage.com/audit-log";
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    for (const env of ["staging", "production"]) writeFileSync(join(root, "infra", `resources.${env}.json`), JSON.stringify({ ...resources(env, 1), account_id: "acct123" }));
    expect(checkIds({ root }).join("\n")).toContain("AUDIT_S3_ENDPOINT");
    applyIds("staging", { root });
    applyIds("production", { root });
    const after = JSON.parse(readFileSync(p, "utf8")).env;
    expect(after.staging.vars.AUDIT_S3_ENDPOINT).toBe("https://acct123.r2.cloudflarestorage.com/audit-log-staging");
    expect(after.production.vars.AUDIT_S3_ENDPOINT).toBe("https://acct123.r2.cloudflarestorage.com/audit-log");
    expect(after.test.vars.AUDIT_S3_ENDPOINT).toBeUndefined();
    expect(checkIds({ root })).toEqual([]);
  });
});

describe("check", () => {
  it("fails when staging and production share an id", () => {
    const root = copyRepo();
    const shared = resources("staging", 1);
    writeFileSync(join(root, "infra", "resources.staging.json"), JSON.stringify(shared));
    writeFileSync(join(root, "infra", "resources.production.json"), JSON.stringify({ ...resources("production", 2), d1: { registry: { id: "d1-staging" } } }));
    expect(checkIds({ root }).join("\n")).toContain("share id d1-staging");
  });

  it("fails when a config id drifts from the resources file, and passes after apply", () => {
    const root = copyRepo();
    for (const env of ["staging", "production"]) writeFileSync(join(root, "infra", `resources.${env}.json`), JSON.stringify(resources(env, 1)));
    expect(checkIds({ root }).length).toBeGreaterThan(0);
    applyIds("staging", { root });
    applyIds("production", { root });
    expect(checkIds({ root })).toEqual([]);
  });

  it("fails when a test id leaks into production", () => {
    const root = copyRepo();
    const p = join(root, "workers", "web", "wrangler.jsonc");
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    cfg.env.production.d1_databases[0].database_id = cfg.env.test.d1_databases[0].database_id;
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    expect(checkIds({ root, resourcesDir: root }).join("\n")).toContain("test and production share id");
  });

  it("main exits non-zero on a problem and zero when clean", () => {
    const out = [];
    expect(main(["--check"], { out: (s) => out.push(s), err: (s) => out.push(s) })).toBe(0);
    expect(main(["--env", "nope"], { out() {}, err() {} })).toBe(2);
  });
});
