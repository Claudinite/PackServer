#!/usr/bin/env node
// Writes the ids from infra/resources.<env>.json into each Worker's wrangler.jsonc env block, and
// checks that staging, production and test never share a resource id (REQ-OPS-003).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ENVS, readConfigs, readTrustTable, suffixed } from "./lib/plan.mjs";
import { resourcesPath } from "./provision.mjs";

const REPO = join(import.meta.dirname, "..");

const USAGE = `Usage: node infra/apply-ids.mjs [--env <staging|production>] [--check]

  (default)  rewrite database_id, KV id and store_id in workers/*/wrangler.jsonc for the env(s)
             from infra/resources.<env>.json; refuses when a needed id is missing
  --check    write nothing: fail when two environments share an id, when a Worker config carries an
             id that differs from a resources file that exists, or when a resources file is missing
             an id its configs need
`;

const prop = (obj, name) => obj?.properties?.find((p) => p.name?.text === name)?.initializer;
const items = (arr) => (arr && ts.isArrayLiteralExpression(arr) ? arr.elements.filter(ts.isObjectLiteralExpression) : []);
const str = (node) => (node && ts.isStringLiteral(node) ? node.text : undefined);

// Every id slot in one env block: where it sits and which resource it must name.
export function idSlots(sourceFile, envName, kvNameByBinding, resourceEnv) {
  const root = sourceFile.statements[0]?.expression;
  const block = prop(prop(root, "env"), envName);
  const slots = [];
  for (const d of items(prop(block, "d1_databases"))) {
    slots.push({ label: `d1 ${str(prop(d, "database_name"))}`, node: prop(d, "database_id"), resource: ["d1", str(prop(d, "database_name"))] });
  }
  for (const k of items(prop(block, "kv_namespaces"))) {
    const binding = str(prop(k, "binding"));
    const name = kvNameByBinding[binding];
    slots.push({ label: `kv ${binding}`, node: prop(k, "id"), resource: ["kv", name === undefined ? undefined : suffixed(resourceEnv, name)] });
  }
  for (const s of items(prop(block, "secrets_store_secrets"))) {
    slots.push({ label: `secrets store for ${str(prop(s, "binding"))}`, node: prop(s, "store_id"), resource: ["secrets_store_id"] });
  }
  const endpoint = prop(prop(block, "vars"), "AUDIT_S3_ENDPOINT");
  if (endpoint) slots.push({ label: "AUDIT_S3_ENDPOINT", node: endpoint, resource: ["audit_endpoint"], kind: "endpoint" });
  return slots.filter((s) => s.node && ts.isStringLiteral(s.node));
}

// The endpoint keeps its path and takes the account id as the host's first label.
const R2_HOST = /^(https:\/\/)[^./]+(\.r2\.cloudflarestorage\.com)/;
function expectedValue(resources, slot) {
  if (slot.kind === "endpoint") {
    return resources.account_id && R2_HOST.test(slot.node.text) ? slot.node.text.replace(R2_HOST, `$1${resources.account_id}$2`) : undefined;
  }
  return idOf(resources, slot.resource);
}

function idOf(resources, resource) {
  if (resource[0] === "secrets_store_id") return resources.secrets_store_id;
  const [kind, name] = resource;
  return name === undefined ? undefined : resources[kind]?.[name]?.id;
}

function loadSource(path) {
  const text = readFileSync(path, "utf8");
  return { text, sf: ts.parseJsonText(path, text) };
}

export function loadResources(env, dir = import.meta.dirname) {
  try {
    return JSON.parse(readFileSync(resourcesPath(env, dir), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}

export function applyIds(env, { root = REPO, resourcesDir = join(root, "infra") } = {}) {
  const resources = loadResources(env, resourcesDir);
  if (!resources) throw new Error(`infra/resources.${env}.json does not exist; run infra/provision.mjs --env ${env}`);
  const trust = readTrustTable(root).workers;
  const missing = [];
  const edits = [];
  for (const { worker, path } of readConfigs(root)) {
    const { text, sf } = loadSource(path);
    const slots = idSlots(sf, env, trust[worker]?.kv ?? {}, env);
    const spliced = [];
    for (const slot of slots) {
      const id = expectedValue(resources, slot);
      if (!id) {
        missing.push(`${worker}: ${slot.label}`);
        continue;
      }
      spliced.push({ start: slot.node.getStart(sf) + 1, end: slot.node.getEnd() - 1, id });
    }
    edits.push({ path, text, spliced });
  }
  if (missing.length) throw new Error(`infra/resources.${env}.json lacks an id for:\n  ${missing.join("\n  ")}`);
  let changed = 0;
  for (const { path, text, spliced } of edits) {
    let next = text;
    for (const e of [...spliced].sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.id + next.slice(e.end);
    if (next !== text) {
      writeFileSync(path, next);
      changed++;
    }
  }
  return changed;
}

// Problems found across all three environments of every Worker config.
export function checkIds({ root = REPO, resourcesDir = join(root, "infra") } = {}) {
  const problems = [];
  const trust = readTrustTable(root).workers;
  const seen = { test: new Map(), staging: new Map(), production: new Map() };
  for (const { worker, path, config } of readConfigs(root)) {
    const { sf } = loadSource(path);
    for (const envName of ["test", ...ENVS]) {
      if (!config.env?.[envName]) continue;
      const resourceEnv = envName === "test" ? "production" : envName;
      for (const slot of idSlots(sf, envName, trust[worker]?.kv ?? {}, resourceEnv)) {
        if (slot.kind === "endpoint") continue;
        const value = slot.node.text;
        if (!seen[envName].has(value)) seen[envName].set(value, `${worker} ${slot.label}`);
      }
    }
  }
  const pairs = [["test", "staging"], ["test", "production"], ["staging", "production"]];
  for (const [a, b] of pairs) {
    for (const [value, where] of seen[a]) {
      if (seen[b].has(value)) problems.push(`${a} and ${b} share id ${value} (${where}; ${seen[b].get(value)})`);
    }
  }
  for (const env of ENVS) {
    const resources = loadResources(env, resourcesDir);
    if (!resources) continue;
    for (const { worker, path } of readConfigs(root)) {
      const { sf } = loadSource(path);
      for (const slot of idSlots(sf, env, trust[worker]?.kv ?? {}, env)) {
        const want = expectedValue(resources, slot);
        if (!want) problems.push(`${worker} env.${env}: infra/resources.${env}.json has no id for ${slot.label}`);
        else if (slot.node.text !== want) problems.push(`${worker} env.${env}: ${slot.label} is ${slot.node.text}, resources file says ${want}`);
      }
    }
  }
  const [staging, production] = ENVS.map((e) => loadResources(e, resourcesDir));
  if (staging && production) {
    const a = collectResourceIds(staging);
    for (const id of collectResourceIds(production)) if (a.has(id)) problems.push(`staging and production resources files share id ${id}`);
  }
  return problems;
}

function collectResourceIds(resources) {
  const ids = new Set();
  for (const kind of ["d1", "kv", "queues"]) for (const v of Object.values(resources[kind] ?? {})) if (v.id) ids.add(v.id);
  if (resources.secrets_store_id) ids.add(resources.secrets_store_id);
  return ids;
}

export function main(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { env: { type: "string" }, check: { type: "boolean" }, help: { type: "boolean" } }, strict: true }));
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (values.env && !ENVS.includes(values.env)) {
    err(`--env must be one of ${ENVS.join(", ")}\n\n${USAGE}`);
    return 2;
  }
  const opts = { root: deps.root ?? REPO };
  try {
    if (values.check) {
      const problems = checkIds(opts);
      if (problems.length) {
        err(`${problems.length} id problem(s):\n  ${problems.join("\n  ")}`);
        return 1;
      }
      out("ids ok: test, staging and production share no id");
      return 0;
    }
    for (const env of values.env ? [values.env] : ENVS) out(`${env}: ${applyIds(env, opts)} config file(s) updated`);
    const problems = checkIds(opts);
    if (problems.length) {
      err(`${problems.length} id problem(s):\n  ${problems.join("\n  ")}`);
      return 1;
    }
    return 0;
  } catch (e) {
    err(e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
