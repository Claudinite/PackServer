// Usage: node tools/check-bindings.mjs [repo-root]
// Holds each Worker's wrangler.jsonc to the trust table (docs/architecture/workers-trust-boundaries.md,
// as data in packages/ports/trust-table.json) and keeps Cloudflare bindings behind each Worker's bindings.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = process.argv[2] ?? join(import.meta.dirname, "..");
const ENVS = ["test", "staging", "production"];
const problems = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);

const BINDING_KEYS = [
  "d1_databases", "kv_namespaces", "r2_buckets", "queues", "workflows", "durable_objects", "containers", "services",
  "vectorize", "ai", "analytics_engine_datasets", "ratelimits", "secrets_store_secrets", "version_metadata",
];
const OTHER_KEYS = ["name", "workers_dev", "routes", "triggers", "vars", "exports"];
const ALLOWED_KEYS = new Set([...BINDING_KEYS, ...OTHER_KEYS]);
// REQ-OPS-003's grep, applied to the configuration a deployment would use.
const TEST_STRINGS = ["fake-", "whsec_test", "1x0000000000000000000000000000000AA", "TEST_MODE", "fireAlarm", "oidc.test"];
const PRODUCT_TYPES = /\b(D1Database|KVNamespace|R2Bucket|VectorizeIndex|AnalyticsEngineDataset|DurableObjectNamespace|SecretsStoreSecret|Fetcher|Ai)\b/;
const ENV_IMPORT = /import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["']cloudflare:workers["']/;

const suffix = (env, name, sep = "-") => (env === "staging" ? `${name}${sep}staging` : name);
const kebab = (s) => s.toLowerCase().replaceAll("_", "-");

function readJsonc(path) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
  return parsed.config;
}

function sameSet(where, what, actual, expected) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) problem(where, `${what} is [${a}], the trust table says [${e}]`);
}

/** The bindings an env block must declare, by kind, derived from the trust table. */
function expected(worker, t, env) {
  const fakeNames = env === "test" ? Object.keys(t.fakes) : [];
  const real = (names) => names.filter((n) => !fakeNames.includes(n));
  const services = Object.entries(t.services).map(([b, target]) => [b, suffix(env, target)]);
  if (env === "test") services.push(...Object.entries(t.fakes));
  return {
    d1: Object.entries(t.d1).map(([b, n]) => [b, suffix(env, n)]),
    kv: Object.keys(t.kv),
    r2: Object.entries(t.r2).map(([b, v]) => [b, suffix(env, v.bucket)]),
    producers: Object.entries(t.queues).map(([b, n]) => [b, suffix(env, n)]),
    consumers: t.queue_consumers.map((n) => suffix(env, n)),
    workflows: Object.entries(t.workflows).map(([b, n]) => [b, suffix(env, n)]),
    doBindings: [
      ...Object.entries(t.durable_objects).map(([b, v]) => [b, v.class, v.host === worker ? undefined : suffix(env, v.host)]),
      ...Object.entries(t.containers).filter(([b]) => !fakeNames.includes(b)).map(([b, cls]) => [b, cls, undefined]),
    ],
    services,
    vectorize: Object.entries(t.vectorize).filter(([b]) => !fakeNames.includes(b)).map(([b, n]) => [b, suffix(env, n)]),
    ai: real(t.ai),
    analytics: Object.entries(t.analytics).map(([b, n]) => [b, suffix(env, n, "_")]),
    ratelimits: t.ratelimits,
    secrets: t.secrets,
  };
}

function checkEnv(worker, t, env, block) {
  const where = `workers/${worker} env.${env}`;
  for (const key of Object.keys(block)) if (!ALLOWED_KEYS.has(key)) problem(where, `unexpected key "${key}"`);
  const want = expected(worker, t, env);
  const pairs = (list) => list.map(([a, b]) => `${a}=${b}`);

  if (block.name !== suffix(env, worker)) problem(where, `name is "${block.name}", expected "${suffix(env, worker)}"`);
  if (block.vars?.WORKER !== worker) problem(where, `vars.WORKER must be "${worker}"`);
  if (block.vars?.ENVIRONMENT !== env) problem(where, `vars.ENVIRONMENT must be "${env}"`);
  if (block.version_metadata?.binding !== "CF_VERSION_METADATA") problem(where, "version_metadata must bind CF_VERSION_METADATA");

  sameSet(where, "D1 databases", pairs((block.d1_databases ?? []).map((d) => [d.binding, d.database_name])), pairs(want.d1));
  sameSet(where, "KV namespaces", (block.kv_namespaces ?? []).map((k) => k.binding), want.kv);
  sameSet(where, "R2 buckets", pairs((block.r2_buckets ?? []).map((b) => [b.binding, b.bucket_name])), pairs(want.r2));
  sameSet(where, "queue producers", pairs((block.queues?.producers ?? []).map((q) => [q.binding, q.queue])), pairs(want.producers));
  sameSet(where, "queue consumers", (block.queues?.consumers ?? []).map((q) => q.queue), want.consumers);
  sameSet(where, "workflows", pairs((block.workflows ?? []).map((w) => [w.binding, w.name])), pairs(want.workflows));
  sameSet(
    where,
    "Durable Object bindings",
    (block.durable_objects?.bindings ?? []).map((d) => `${d.name}=${d.class_name}@${d.script_name ?? "self"}`),
    want.doBindings.map(([b, cls, host]) => `${b}=${cls}@${host ?? "self"}`),
  );
  sameSet(where, "service bindings", pairs((block.services ?? []).map((s) => [s.binding, s.service])), pairs(want.services));
  sameSet(where, "Vectorize indexes", pairs((block.vectorize ?? []).map((v) => [v.binding, v.index_name])), pairs(want.vectorize));
  sameSet(where, "AI bindings", block.ai ? [block.ai.binding] : [], want.ai);
  sameSet(where, "Analytics Engine datasets", pairs((block.analytics_engine_datasets ?? []).map((a) => [a.binding, a.dataset])), pairs(want.analytics));
  sameSet(where, "rate limits", (block.ratelimits ?? []).map((r) => r.name), want.ratelimits);

  if (env === "test") {
    sameSet(where, "secrets given as test vars", want.secrets.filter((s) => block.vars?.[s] !== undefined), want.secrets);
    sameSet(where, "Secrets Store bindings", (block.secrets_store_secrets ?? []).map((s) => s.binding), []);
    if (block.containers?.length) problem(where, "containers have no local implementation; the sandboxes are fake Workers under env.test");
    if (block.triggers?.crons?.length) problem(where, "env.test must not fire crons on its own");
  } else {
    sameSet(where, "Secrets Store bindings", (block.secrets_store_secrets ?? []).map((s) => `${s.binding}=${s.secret_name}`), want.secrets.map((s) => `${s}=${suffix(env, kebab(s))}`));
    sameSet(where, "containers", (block.containers ?? []).map((c) => c.class_name), Object.values(t.containers));
    for (const s of want.secrets) if (block.vars?.[s] !== undefined) problem(where, `secret ${s} must not be a plain var outside env.test`);
    if (block.workers_dev !== false) problem(where, "workers_dev must be false");
    for (const r of block.ratelimits ?? []) if (!/^\d+$/.test(String(r.namespace_id))) problem(where, `rate limit ${r.name} needs a numeric namespace_id`);
  }
  for (const [name, cls] of Object.entries(t.containers)) {
    if ((block.exports?.[cls]?.type) !== "durable-object") problem(where, `container class ${cls} (${name}) must be exported as a durable-object`);
  }
  for (const [, v] of Object.entries(t.durable_objects)) {
    if (v.host === worker && block.exports?.[v.class]?.type !== "durable-object") problem(where, `hosted class ${v.class} must be exported as a durable-object`);
  }
  if (Object.keys(t.workflows).length && worker === "validator" && block.exports?.ValidatePackWorkflow?.type !== "workflow") {
    problem(where, "ValidatePackWorkflow must be exported as a workflow");
  }
}

function checkRoutes(worker, env, block) {
  const where = `workers/${worker} env.${env}`;
  const patterns = (block.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
  if (env === "test") {
    if (patterns.length) problem(where, "env.test must have no routes; the harness dispatches directly");
    return;
  }
  if (patterns.length === 0) problem(where, "needs at least one route");
  if (worker === "validator") {
    for (const p of patterns) if (!/^registry-(canary|staging)\.claudinite\.com\/validator\/__selftest$/.test(p)) problem(where, `validator has no public route, but routes "${p}"`);
  }
  if (worker === "admin") {
    for (const p of patterns) if (!/^registry-admin(-staging)?\.claudinite\.com\//.test(p)) problem(where, `admin is served on its own host only, not "${p}"`);
  }
  if (worker === "prober") {
    for (const p of patterns) if (!/\/prober\/__selftest$/.test(p)) problem(where, `prober has no route but its self-test, not "${p}"`);
  }
}

function checkInvariants(worker, t, env, block) {
  const where = `workers/${worker} env.${env}`;
  const buckets = (block.r2_buckets ?? []).map((b) => b.bucket_name);
  if (buckets.some((b) => b.startsWith("audit-log"))) problem(where, "no Worker has a binding to audit-log");
  const secrets = block.secrets_store_secrets?.map((s) => s.binding) ?? Object.keys(block.vars ?? {});
  if (secrets.includes("SIGNING_KEY_ACTIVE") && worker !== "validator") problem(where, "only the validator holds the signing key");
  if (secrets.some((s) => s.startsWith("SIGNING_KEY_") && s !== "SIGNING_KEY_ACTIVE")) problem(where, "the standby signing key is bound to nothing");
  if (secrets.some((s) => s.startsWith("GITHUB_")) && worker !== "github") problem(where, "GitHub App secrets belong to the github Worker alone");
  if (secrets.includes("TURNSTILE_SECRET") && worker !== "web") problem(where, "only web holds the Turnstile secret");
  if ((block.workflows ?? []).length && !["publish", "validator", "admin"].includes(worker)) problem(where, "this Worker must never hold Workflows");
  if (env !== "test") {
    const text = JSON.stringify(block);
    for (const s of TEST_STRINGS) if (text.includes(s)) problem(where, `test string "${s}" in a deployed configuration`);
  }
}

function checkResources(configs) {
  // The same logical resource has one id wherever it is bound; no staging or production id or name is shared.
  // The test environment is local, so only its D1 and KV ids are held apart from the deployed ones.
  const seen = new Map();
  const note = (env, key, value) => {
    const k = `${env}|${key}`;
    if (seen.has(k) && seen.get(k) !== value) problem("resources", `${key} has two ids in env.${env}: ${seen.get(k)} and ${value}`);
    seen.set(k, value);
  };
  for (const [worker, config] of Object.entries(configs)) {
    for (const env of ENVS) {
      const b = config.env?.[env] ?? {};
      for (const d of b.d1_databases ?? []) note(env, `d1:${d.database_name.replace(/-staging$/, "")}`, d.database_id);
      for (const k of b.kv_namespaces ?? []) note(env, `kv:${worker}:${k.binding}`, k.id);
    }
  }
  const ids = (b) => [
    ...(b.d1_databases ?? []).map((d) => `d1 id ${d.database_id}`),
    ...(b.kv_namespaces ?? []).map((k) => `kv id ${k.id}`),
  ];
  const deployedIds = (b) => [...ids(b), ...(b.ratelimits ?? []).map((r) => `rate limit namespace ${r.namespace_id}`)];
  const names = (b) => [
    ...(b.d1_databases ?? []).map((d) => `d1 ${d.database_name}`),
    ...(b.r2_buckets ?? []).map((r) => `r2 ${r.bucket_name}`),
    ...(b.queues?.producers ?? []).map((q) => `queue ${q.queue}`),
    ...(b.queues?.consumers ?? []).flatMap((q) => [q.queue, q.dead_letter_queue].filter(Boolean).map((n) => `queue ${n}`)),
    ...(b.vectorize ?? []).map((v) => `vectorize ${v.index_name}`),
    ...(b.workflows ?? []).map((w) => `workflow ${w.name}`),
    ...(b.analytics_engine_datasets ?? []).map((a) => `dataset ${a.dataset}`),
    ...(b.secrets_store_secrets ?? []).map((s) => `secret ${s.secret_name}`),
  ];
  const collect = (env, pick) => new Set(Object.values(configs).flatMap((c) => pick(c.env?.[env] ?? {})));
  const compare = (a, b, pick, what) => {
    const left = collect(a, pick);
    for (const x of collect(b, pick)) if (left.has(x)) problem("resources", `env.${a} and env.${b} share the ${what} "${x}"`);
  };
  compare("staging", "production", deployedIds, "resource");
  compare("staging", "production", names, "resource");
  compare("test", "production", ids, "resource");
  compare("test", "staging", ids, "resource");
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

function checkSeam(worker, t) {
  const names = [
    ...["d1", "kv", "r2", "queues", "workflows", "durable_objects", "containers", "services", "vectorize", "analytics"].flatMap((k) => Object.keys(t[k])),
    ...t.ai, ...t.ratelimits, ...t.secrets, ...Object.keys(t.fakes), "CF_VERSION_METADATA",
  ];
  // `env` (or a cast of it) followed by a property access of a binding name; `ports.kv.NAME` is a port, not a binding.
  const named = new RegExp(`\\benv\\b[^;\\n]{0,24}?(?:\\.|\\[\\s*["'])\\s*(${names.join("|")})\\b`);
  for (const file of sourceFiles(join(root, "workers", worker, "src"))) {
    if (file.endsWith("/bindings.ts")) continue;
    const rel = file.slice(root.length + 1);
    const text = readFileSync(file, "utf8");
    const hit = named.exec(text);
    if (hit) problem(rel, `touches binding ${hit[1]} outside bindings.ts`);
    if (ENV_IMPORT.test(text)) problem(rel, 'imports `env` from "cloudflare:workers"; bindings are read in bindings.ts only');
    const type = PRODUCT_TYPES.exec(text);
    if (type) problem(rel, `names the Cloudflare binding type ${type[1]} outside bindings.ts`);
  }
}

const table = JSON.parse(readFileSync(join(root, "packages/ports/trust-table.json"), "utf8")).workers;
const configs = {};
for (const [worker, t] of Object.entries(table)) {
  const path = join(root, "workers", worker, "wrangler.jsonc");
  if (!existsSync(path)) {
    problem(`workers/${worker}`, "has no wrangler.jsonc");
    continue;
  }
  const config = readJsonc(path);
  configs[worker] = config;
  if (!config.name || !config.main || !config.compatibility_date) problem(`workers/${worker}`, "needs name, main and compatibility_date at the top level");
  sameSet(`workers/${worker}`, "environments", Object.keys(config.env ?? {}), ENVS);
  for (const env of ENVS) {
    const block = config.env?.[env];
    if (!block) continue;
    checkEnv(worker, t, env, block);
    checkRoutes(worker, env, block);
    checkInvariants(worker, t, env, block);
    if (env !== "test" && ["github", "validator", "admin", "judge", "prober"].includes(worker) && !block.triggers?.crons?.length) {
      problem(`workers/${worker} env.${env}`, "needs cron triggers");
    }
  }
  checkSeam(worker, t);
}
const writers = Object.entries(table).filter(([, t]) => Object.values(t.r2).some((v) => v.access !== "read" && ["packs-public", "packs-private"].includes(v.bucket))).map(([w]) => w);
sameSet("trust table", "Workers that can write the public and private buckets", writers, ["validator"]);
for (const [w, t] of Object.entries(table)) {
  for (const f of Object.keys(t.fakes)) if (!/^[A-Z][A-Z0-9_]*$/.test(f)) problem(`trust table ${w}`, `fake binding ${f} is not an env name`);
}
checkResources(configs);

if (problems.length > 0) {
  console.error(problems.map((p) => `check-bindings: ${p}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`check-bindings: ${Object.keys(table).length} Workers, ${ENVS.length} environments each, ok`);
}
