// The resource list for one environment, read from the Workers' wrangler.jsonc env blocks and the
// trust table, so a binding added to a Worker is provisioned without editing a second list.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export const ENVS = ["staging", "production"];
export const ZONE = "claudinite.com";
const REPO = join(import.meta.dirname, "..", "..");

// Embedding model -> vector dimensions. The model decides the number: an index's dimension count
// cannot change after creation, so no value is ever defaulted or guessed.
export const EMBEDDING_MODELS = { "@cf/baai/bge-m3": 1024 };
export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";

// Resources no Worker binding names, with the reason each exists.
export const EXTRAS = {
  r2: ["audit-log"],
  queues: [],
};

// Public hosts of the R2 custom domains, keyed by the (suffixed) bucket they front.
export const R2_CUSTOM_DOMAINS = {
  production: { "packs-public": `packs.${ZONE}` },
  staging: { "packs-public-staging": `packs-staging.${ZONE}` },
};

// Created only when the account has no store; the beta allows one store per account.
export const SECRETS_STORE_NAME = "packserver";
export const TURNSTILE_BINDING = "TURNSTILE_SECRET";
/** The one Worker that holds the audit bucket's token. */
export const AUDIT_WORKER = "admin";
export const AUDIT_BINDINGS = { accessKeyId: "AUDIT_S3_ACCESS_KEY_ID", secretAccessKey: "AUDIT_S3_SECRET_ACCESS_KEY" };

export const suffixed = (env, name) => (env === "staging" ? `${name}-staging` : name);

export function readJsonc(path) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
  return parsed.config;
}

export function readConfigs(root = REPO) {
  const dir = join(root, "workers");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ worker: d.name, path: join(dir, d.name, "wrangler.jsonc"), config: readJsonc(join(dir, d.name, "wrangler.jsonc")) }));
}

export function readTrustTable(root = REPO) {
  return JSON.parse(readFileSync(join(root, "packages", "ports", "trust-table.json"), "utf8"));
}

const sorted = (set) => [...set].sort();

export function planResources(env, { root = REPO } = {}) {
  if (!ENVS.includes(env)) throw new Error(`--env must be "staging" or "production", got "${env}"`);
  const d1 = new Set();
  const r2 = new Set();
  const queues = new Set();
  const vectorize = new Set();
  const hosts = new Map();
  let turnstileSecretName;
  const webHosts = new Set();
  const audit = {};
  for (const { worker, path, config } of readConfigs(root)) {
    const block = config.env?.[env];
    if (!block) throw new Error(`${path}: no env.${env} block`);
    for (const d of block.d1_databases ?? []) d1.add(d.database_name);
    for (const b of block.r2_buckets ?? []) r2.add(b.bucket_name);
    for (const p of block.queues?.producers ?? []) queues.add(p.queue);
    for (const c of block.queues?.consumers ?? []) {
      queues.add(c.queue);
      if (c.dead_letter_queue) queues.add(c.dead_letter_queue);
    }
    for (const v of block.vectorize ?? []) vectorize.add(v.index_name);
    for (const s of block.secrets_store_secrets ?? []) {
      if (s.binding === TURNSTILE_BINDING) turnstileSecretName = s.secret_name;
      if (worker === AUDIT_WORKER) for (const [field, binding] of Object.entries(AUDIT_BINDINGS)) if (s.binding === binding) audit[field] = s.secret_name;
    }
    for (const r of block.routes ?? []) {
      const [host, ...rest] = (typeof r === "string" ? r : r.pattern).split("/");
      if (worker === "web") webHosts.add(host);
      if (!hosts.has(host)) hosts.set(host, new Set());
      hosts.get(host).add(`${block.name ?? worker} /${rest.join("/")}`);
    }
  }
  const kv = new Set();
  for (const w of Object.values(readTrustTable(root).workers)) for (const name of Object.values(w.kv)) kv.add(suffixed(env, name));
  for (const n of EXTRAS.r2) r2.add(suffixed(env, n));
  for (const n of EXTRAS.queues) queues.add(suffixed(env, n));
  for (const d of Object.values(R2_CUSTOM_DOMAINS[env])) {
    if (hosts.has(d)) throw new Error(`${d} is both a Worker route host and an R2 custom domain; a placeholder record would block the bucket`);
  }
  if (!turnstileSecretName) throw new Error(`no ${TURNSTILE_BINDING} secrets_store_secrets entry in env.${env} of any Worker`);
  for (const [field, binding] of Object.entries(AUDIT_BINDINGS)) {
    if (!audit[field]) throw new Error(`no ${binding} secrets_store_secrets entry in env.${env} of the ${AUDIT_WORKER} Worker`);
  }
  return {
    env,
    d1: sorted(d1),
    kv: sorted(kv),
    r2: sorted(r2),
    vectorize: sorted(vectorize),
    queues: sorted(queues),
    hosts: sorted(hosts.keys()),
    r2CustomDomains: R2_CUSTOM_DOMAINS[env],
    turnstile: { name: suffixed(env, "packserver"), domains: sorted(webHosts), secretName: turnstileSecretName },
    secretsStore: SECRETS_STORE_NAME,
    auditSecrets: audit,
  };
}

export function embeddingDimensions(model) {
  const dims = EMBEDDING_MODELS[model];
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`unknown embedding model "${model}": refusing to guess a Vectorize dimension count (known: ${Object.keys(EMBEDDING_MODELS).join(", ")})`);
  }
  return dims;
}
