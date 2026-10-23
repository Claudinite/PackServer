// Usage: node tools/check-bindings.mjs [repo-root]
// Holds each Worker's wrangler.jsonc to the trust table (docs/architecture/workers-trust-boundaries.md,
// as data in packages/ports/trust-table.json) and keeps Cloudflare bindings behind each Worker's bindings.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { TEST_STRINGS } from "./test-strings.mjs";

let root;
const ENVS = ["test", "staging", "production"];
let problems;
const problem = (where, message) => problems.push(`${where}: ${message}`);

const BINDING_KEYS = [
  "d1_databases", "kv_namespaces", "r2_buckets", "queues", "workflows", "durable_objects", "containers", "services",
  "vectorize", "ai", "analytics_engine_datasets", "ratelimits", "secrets_store_secrets", "version_metadata",
];
const OTHER_KEYS = ["name", "workers_dev", "preview_urls", "routes", "triggers", "vars", "exports"];
const ALLOWED_KEYS = new Set([...BINDING_KEYS, ...OTHER_KEYS]);
const PRODUCT_TYPES = /\b(D1Database|KVNamespace|R2Bucket|VectorizeIndex|AnalyticsEngineDataset|DurableObjectNamespace|SecretsStoreSecret|Fetcher|Ai)\b/;
// The one folder allowed to speak a binding's own API, besides each Worker's bindings.ts.
const ADAPTER_DIR = join("packages", "ports", "cloudflare");
// The test world drives the harness from Node: it reads Workers' bindings through the harness's
// getEnv() and addresses fake Workers by name, which is the test seam itself and ships in no bundle.
const TEST_WORLD_DIR = join("packages", "test-world");
const ENV_IMPORT = /import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["']cloudflare:workers["']/;

// The GitHub App's OAuth client id and secret: web finishes GitHub sign-in with them. The App's private key and webhook secret stay with the github Worker.
const WEB_SIGN_IN_SECRETS = ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"];

const suffix = (env, name, sep = "-") => (env === "production" ? name : `${name}${sep}${env}`);
const workerName = suffix;
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
  const services = Object.entries(t.services).map(([b, target]) => [b, workerName(env, target)]);
  if (env === "test") services.push(...Object.entries(t.fakes));
  return {
    d1: Object.entries(t.d1).map(([b, n]) => [b, suffix(env, n)]),
    kv: Object.keys(t.kv),
    r2: Object.entries(t.r2).map(([b, v]) => [b, suffix(env, v.bucket)]),
    producers: Object.entries(t.queues).map(([b, n]) => [b, suffix(env, n)]),
    consumers: t.queue_consumers.map((n) => suffix(env, n)),
    workflows: Object.entries(t.workflows).map(([b, n]) => [b, suffix(env, n)]),
    doBindings: [
      ...Object.entries(t.durable_objects).map(([b, v]) => [b, v.class, v.host === worker ? undefined : workerName(env, v.host)]),
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

  if (block.workers_dev !== false) problem(where, "workers_dev must be false");
  if (block.preview_urls !== false) problem(where, "preview_urls must be false");
  if (block.name !== workerName(env, worker)) problem(where, `name is "${block.name}", expected "${workerName(env, worker)}"`);
  if (block.vars?.WORKER !== worker) problem(where, `vars.WORKER must be "${worker}"`);
  if (block.vars?.ENVIRONMENT !== env) problem(where, `vars.ENVIRONMENT must be "${env}"`);
  if (block.version_metadata?.binding !== "CF_VERSION_METADATA") problem(where, "version_metadata must bind CF_VERSION_METADATA");

  sameSet(where, "D1 databases", pairs((block.d1_databases ?? []).map((d) => [d.binding, d.database_name])), pairs(want.d1));
  sameSet(where, "KV namespaces", (block.kv_namespaces ?? []).map((k) => k.binding), want.kv);
  sameSet(where, "R2 buckets", pairs((block.r2_buckets ?? []).map((b) => [b.binding, b.bucket_name])), pairs(want.r2));
  sameSet(where, "queue producers", pairs((block.queues?.producers ?? []).map((q) => [q.binding, q.queue])), pairs(want.producers));
  sameSet(where, "queue consumers", (block.queues?.consumers ?? []).map((q) => q.queue), want.consumers);
  sameSet(where, "workflows", pairs((block.workflows ?? []).map((w) => [w.binding, w.name])), pairs(want.workflows));
  for (const w of block.workflows ?? []) {
    const host = worker === "validator" ? undefined : workerName(env, "validator");
    if (w.script_name !== host) problem(where, `workflow ${w.binding} runs in "${w.script_name}", expected "${host}"`);
  }
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
  const foreign = secrets.filter((s) => s.startsWith("GITHUB_") && !(worker === "web" && WEB_SIGN_IN_SECRETS.includes(s)));
  if (foreign.length && worker !== "github") problem(where, `GitHub App secrets belong to the github Worker alone, except the sign-in client credentials web exchanges codes with (${foreign.join(", ")})`);
  if (secrets.includes("TURNSTILE_SECRET") && worker !== "web") problem(where, "only web holds the Turnstile secret");
  if ((block.workflows ?? []).length && !["validator", "admin"].includes(worker)) problem(where, "this Worker must never hold Workflows");
  if (env !== "test") {
    const text = JSON.stringify(block);
    for (const s of TEST_STRINGS) if (text.includes(s)) problem(where, `test string "${s}" in a deployed configuration`);
  }
}

function checkResources(table, configs) {
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
      for (const k of b.kv_namespaces ?? []) note(env, `kv:${table[worker].kv[k.binding] ?? `${worker}:${k.binding}`}`, k.id);
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
  // A stray `wrangler deploy --env test` must replace nothing deployed, so no test Worker name or id may equal one.
  const workerNames = (b) => [b.name];
  compare("staging", "production", deployedIds, "resource");
  compare("staging", "production", names, "resource");
  for (const [a, b] of [["test", "production"], ["test", "staging"], ["staging", "production"]]) compare(a, b, workerNames, "Worker name");
  compare("test", "production", deployedIds, "resource");
  compare("test", "staging", deployedIds, "resource");
  compare("test", "production", names, "resource");
  compare("test", "staging", names, "resource");
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".wrangler") return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

const unwrap = (node) => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
};
const isEnvType = (type) => type !== undefined && ts.isTypeReferenceNode(type) && /Env$/.test(type.typeName.getText());
const literalText = (node) => (ts.isStringLiteralLike(node) ? node.text : undefined);

/** Every place a source file reads a binding by name off `env`, in any spelling: `env.X`, `c.env.X`, `env["X"]`, `{ X } = env`, or any of those through an alias of `env` or a parameter typed `Env`. */
function bindingReads(sourceFile, names) {
  const aliases = new Set(["env"]);
  const isEnvLike = (node) => {
    const n = unwrap(node);
    return (ts.isIdentifier(n) && aliases.has(n.text)) || (ts.isPropertyAccessExpression(n) && n.name.text === "env");
  };
  const holdsEnv = (decl) => (decl.initializer !== undefined && isEnvLike(decl.initializer)) || isEnvType(decl.type);
  const declarations = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of declarations) {
      if (ts.isIdentifier(d.name) && holdsEnv(d) && !aliases.has(d.name.text)) {
        aliases.add(d.name.text);
        grew = true;
      }
    }
  }
  const reads = [];
  // Building an env (`env.X = …`) is not reading one.
  const assigned = (node) => node.parent !== undefined && ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.parent.left === node;
  const scan = (node) => {
    if (assigned(node)) return ts.forEachChild(node, scan);
    if (ts.isPropertyAccessExpression(node) && isEnvLike(node.expression) && names.has(node.name.text)) reads.push({ node, name: node.name.text });
    if (ts.isElementAccessExpression(node) && isEnvLike(node.expression) && names.has(literalText(node.argumentExpression) ?? "")) {
      reads.push({ node, name: literalText(node.argumentExpression) });
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isObjectBindingPattern(node.name) && holdsEnv(node)) {
      for (const element of node.name.elements) {
        const name = (element.propertyName ?? element.name).getText();
        if (names.has(name)) reads.push({ node: element, name });
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(sourceFile);
  return reads;
}

const DO_BASES = new Set(["DurableObject", "WorkflowEntrypoint"]);
const inObjectClass = (node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isClassLike(n)) return (n.heritageClauses ?? []).some((h) => h.types.some((t) => DO_BASES.has(t.expression.getText())));
  }
  return false;
};

/** What a file does with `env` itself, whatever it then reads from it: a `.env` member, an `env` key in a destructure, the Env type. */
function envStructure(sourceFile) {
  const found = { dotEnv: false, destructured: false, envImport: false };
  const visit = (node) => {
    // A Durable Object or Workflow class owns its `this.env`; the binding names it may read off it are still held to bindings.ts.
    if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && !(ts.isIdentifier(node.expression) && node.expression.text === "process") && !(node.expression.kind === ts.SyntaxKind.ThisKeyword && inObjectClass(node))) found.dotEnv = true;
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && (node.propertyName ?? node.name).getText() === "env") found.destructured = true;
    if (ts.isImportDeclaration(node) && /(^|\/)bindings$/.test(literalText(node.moduleSpecifier) ?? "")) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named) && named.elements.some((e) => (e.propertyName ?? e.name).text === "Env")) found.envImport = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** A Worker's handlers get `env` as their second parameter; in index.ts it may be used only as `createRuntime(env)`. */
function handlerEnvOnlyReachesRuntime(sourceFile) {
  let ok = true;
  const guardedUse = (ref) => {
    let child = ref;
    while (ts.isParenthesizedExpression(child.parent) || ts.isAsExpression(child.parent) || ts.isNonNullExpression(child.parent)) child = child.parent;
    const call = child.parent;
    return ts.isCallExpression(call) && call.arguments[0] === child && ts.isIdentifier(call.expression) && call.expression.text === "createRuntime";
  };
  const visit = (node) => {
    const handler =
      (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && node.initializer) ||
      (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent) && node);
    const param = handler && handler.parameters[1];
    if (param && !ts.isIdentifier(param.name)) ok = false;
    if (param && ts.isIdentifier(param.name) && handler.body) {
      const refs = [];
      const collect = (n) => {
        if (ts.isIdentifier(n) && n.text === param.name.text && n !== param.name && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) refs.push(n);
        ts.forEachChild(n, collect);
      };
      collect(handler.body);
      if (!refs.every(guardedUse)) ok = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ok;
}

// Repeated runs in one process (the tests) re-read mostly unchanged sources, so a parse is kept per text.
const parsed = new Map();
function parse(file) {
  const text = readFileSync(file, "utf8");
  const tsx = file.endsWith("x");
  const key = `${tsx}\0${text}`;
  if (!parsed.has(key)) parsed.set(key, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return { text, sourceFile: parsed.get(key) };
}

/** A read-only bucket is read-only because `bindings.ts` hands it to `r2ReadPort` and to nothing else; the platform has no such binding. */
function checkReadOnlyBuckets(worker, t, sourceFile, rel) {
  const readOnly = Object.entries(t.r2).filter(([, v]) => v.access === "read").map(([b]) => b);
  const reads = bindingReads(sourceFile, new Set(readOnly));
  for (const bucket of readOnly) {
    const mine = reads.filter((r) => r.name === bucket);
    const guarded = (r) => {
      let child = r.node;
      while (ts.isParenthesizedExpression(child.parent) || ts.isAsExpression(child.parent) || ts.isNonNullExpression(child.parent)) child = child.parent;
      const call = child.parent;
      return ts.isCallExpression(call) && call.arguments[0] === child && ts.isIdentifier(call.expression) && call.expression.text === "r2ReadPort";
    };
    if (mine.length === 0 || !mine.every(guarded)) problem(rel, `read-only bucket ${bucket} must reach the code only as r2ReadPort(env.${bucket})`);
  }
}

function checkSeam(table) {
  const names = new Set(
    Object.values(table).flatMap((t) => [
      ...["d1", "kv", "r2", "queues", "workflows", "durable_objects", "containers", "services", "vectorize", "analytics"].flatMap((k) => Object.keys(t[k])),
      ...t.ai, ...t.ratelimits, ...t.secrets, ...Object.keys(t.fakes), "CF_VERSION_METADATA",
    ]),
  );
  const files = [
    ...Object.keys(table).flatMap((worker) => sourceFiles(join(root, "workers", worker, "src"))),
    ...sourceFiles(join(root, "packages")).filter((f) => ![ADAPTER_DIR, TEST_WORLD_DIR].some((dir) => relative(root, f).startsWith(dir + sep))),
  ];
  for (const file of files) {
    const rel = relative(root, file);
    const { text, sourceFile } = parse(file);
    const seam = /^workers\/[^/]+\/src\/bindings\.ts$/.test(rel.split(sep).join("/"));
    if (seam) {
      const worker = rel.split(sep)[1];
      if (table[worker]) checkReadOnlyBuckets(worker, table[worker], sourceFile, rel);
      continue;
    }
    const hit = bindingReads(sourceFile, names)[0];
    if (hit) problem(rel, `touches binding ${hit.name} outside bindings.ts`);
    const structure = envStructure(sourceFile);
    if (structure.dotEnv) problem(rel, "reads `.env` outside bindings.ts");
    if (structure.destructured) problem(rel, "destructures `env` outside bindings.ts");
    if (structure.envImport && !/^workers\/[^/]+\/src\/index\.ts$/.test(rel.split(sep).join("/"))) problem(rel, "imports the Env type outside bindings.ts and index.ts");
    if (/^workers\/[^/]+\/src\/index\.ts$/.test(rel.split(sep).join("/")) && !handlerEnvOnlyReachesRuntime(sourceFile)) {
      problem(rel, "hands the handler's env to something other than createRuntime");
    }
    if (ENV_IMPORT.test(text)) problem(rel, 'imports `env` from "cloudflare:workers"; bindings are read in bindings.ts only');
    const type = PRODUCT_TYPES.exec(text);
    if (type) problem(rel, `names the Cloudflare binding type ${type[1]} outside bindings.ts`);
  }
}

/** Runs every check against the repository at rootDir and returns the problems found. */
export function checkBindings(rootDir) {
  root = rootDir;
  problems = [];
  const table = JSON.parse(readFileSync(join(root, "packages/ports/trust-table.json"), "utf8")).workers;
  // The test-only binding names live in their own file so no production bundle carries them (IT-OPS-003).
  const testFakes = JSON.parse(readFileSync(join(root, "packages/ports/test-fakes.json"), "utf8"));
  for (const w of Object.keys(testFakes)) if (!table[w]) problem("packages/ports/test-fakes.json", `names ${w}, which the trust table does not`);
  for (const [w, t] of Object.entries(table)) t.fakes = testFakes[w] ?? {};
  const configs = {};
  for (const [worker, t] of Object.entries(table)) {
    const path = join(root, "workers", worker, "wrangler.jsonc");
    if (!existsSync(path)) {
      problem(`workers/${worker}`, "has no wrangler.jsonc");
      continue;
    }
    const config = readJsonc(path);
    configs[worker] = config;
    if (!readFileSync(path, "utf8").endsWith("\n")) problem(`workers/${worker}`, "wrangler.jsonc must end with a newline");
    // A bare `wrangler deploy` reads the top level, so it must name a Worker that exists nowhere and bind and route nothing.
    if (config.name !== `${worker}-local`) problem(`workers/${worker}`, `top-level name is "${config.name}", expected "${worker}-local"`);
    if (config.workers_dev !== false) problem(`workers/${worker}`, "the top level needs workers_dev: false");
    if (config.preview_urls !== false) problem(`workers/${worker}`, "the top level needs preview_urls: false");
    if (config.routes?.length || config.route) problem(`workers/${worker}`, "the top level must not declare routes");
    for (const key of [...BINDING_KEYS, "triggers"]) if (config[key] !== undefined) problem(`workers/${worker}`, `the top level must not declare ${key}`);
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
  }
  const writers = Object.entries(table).filter(([, t]) => Object.values(t.r2).some((v) => v.access !== "read" && ["packs-public", "packs-private"].includes(v.bucket))).map(([w]) => w);
  sameSet("trust table", "Workers that can write the public and private buckets", writers, ["validator"]);
  for (const [w, t] of Object.entries(table)) {
    for (const f of Object.keys(t.fakes)) if (!/^[A-Z][A-Z0-9_]*$/.test(f)) problem(`trust table ${w}`, `fake binding ${f} is not an env name`);
  }
  checkSeam(table);
  checkResources(table, configs);
  return { problems, workers: Object.keys(table).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { problems: found, workers } = checkBindings(process.argv[2] ?? join(import.meta.dirname, ".."));
  if (found.length > 0) {
    console.error(found.map((p) => `check-bindings: ${p}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`check-bindings: ${workers} Workers, ${ENVS.length} environments each, ok`);
  }
}
