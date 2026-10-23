#!/usr/bin/env node
// Creates or confirms every Cloudflare resource an environment needs and writes their ids to
// infra/resources.<env>.json. Re-running changes nothing that already exists.
//
// A resource is created only when a listing that succeeded and was read to its last page does not
// contain it. Any failed, partial or unrecognisable answer stops that resource with an error.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ConfigError, call, createSecretsStore, resolveCloudflareConfig } from "./lib/secrets-store.mjs";
import { DEFAULT_EMBEDDING_MODEL, ENVS, ZONE, embeddingDimensions, planResources, suffixed } from "./lib/plan.mjs";

const REPO = join(import.meta.dirname, "..");
const PER_PAGE = 100;
const TOKENS_PER_PAGE = 50;

export const resourcesPath = (env, dir = import.meta.dirname) => join(dir, `resources.${env}.json`);

// Object tokens: the least R2 permission each consumer needs. Bucket admin is never requested.
export const TOKEN_SPECS = [
  { key: "audit-log", bucket: "audit-log", permissions: ["Workers R2 Storage Bucket Item Read", "Workers R2 Storage Bucket Item Write"], audit: true },
  { key: "ops-releases", bucket: "ops", permissions: ["Workers R2 Storage Bucket Item Write"], handOver: "CN_RELEASES_S3" },
];

const USAGE = `Usage: node infra/provision.mjs --env <staging|production> [--dry-run] [--d1-location-hint <hint>]
                               [--embedding-model <model>] [--print-ops-token]

Creates or confirms D1, KV, R2 (and each bucket's r2.dev setting), Vectorize, Queues, the Secrets
Store, the Turnstile widget, the R2 custom domain, DNS for every routed hostname, and the two
object-only R2 tokens, then writes infra/resources.<env>.json. The resource list is read from
workers/*/wrangler.jsonc and the trust table.

Requires CF_BOOTSTRAP_TOKEN. CLOUDFLARE_ACCOUNT_ID is looked up when the token sees exactly one
account; CLOUDFLARE_SECRETS_STORE_ID is not used (the store is found or created by name).

  --d1-location-hint  D1 placement hint, default enam (M-01 records the production choice)
  --embedding-model   model fixing the Vectorize dimension count (default ${DEFAULT_EMBEDDING_MODEL})
  --print-ops-token   print the ops/cn-releases write token once, as KEY=VALUE lines for the engine
                      repo's secrets; it is shown only when this run minted it
  --dry-run           print what would be ensured; no network
  --help              this text
`;

// One API path read to its last page. Completeness comes from what the server reports: total_pages,
// else total_count, else the page size it echoes (it may cap the one we asked for). A listing that
// cannot be shown to be complete is an error.
async function listAll(api, path, pick, perPage = PER_PAGE) {
  const items = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const json = await api("GET", `${path}${sep}page=${page}&per_page=${perPage}`);
    const got = pick(json);
    if (!Array.isArray(got)) throw new Error(`unrecognised listing shape for ${path}`);
    items.push(...got);
    const info = json.result_info ?? {};
    if (Number.isInteger(info.total_pages)) {
      if (page >= info.total_pages) return items;
    } else if (Number.isInteger(info.total_count)) {
      if (items.length >= info.total_count) return items;
    } else if (Number.isInteger(info.per_page) && info.per_page > 0) {
      if (got.length < info.per_page) return items;
    } else {
      throw new Error(`cannot tell whether ${path} was listed completely`);
    }
    if (got.length === 0) throw new Error(`${path} ended before its reported total`);
  }
}

async function listR2Buckets(api) {
  const names = [];
  let cursor;
  for (;;) {
    const json = await api("GET", `/r2/buckets?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const got = json.result?.buckets;
    if (!Array.isArray(got)) throw new Error("unrecognised listing shape for /r2/buckets");
    names.push(...got.map((b) => b.name));
    cursor = json.result_info?.cursor;
    if (!cursor || got.length === 0) {
      if (got.length >= 1000) throw new Error("cannot tell whether /r2/buckets was listed completely");
      return names;
    }
  }
}

export async function provision(env, opts, deps) {
  const { fetch: fetchImpl, token, accountId, out, plan } = deps;
  const failures = [];
  const ids = { env, account_id: accountId };
  const acct = (method, path, body) => call(fetchImpl, token, method, `/accounts/${accountId}${path}`, body);
  const api = (method, path, body) => call(fetchImpl, token, method, path, body);
  const revoke = async (tokenId) => {
    try {
      await acct("DELETE", `/tokens/${tokenId}`);
      return `the token ${tokenId} was revoked`;
    } catch (e) {
      return `the token ${tokenId} could NOT be revoked (${e.message}); revoke it by hand`;
    }
  };
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
      out(`FAILED ${label}: ${e.message}`);
      return undefined;
    }
  };

  // Confirms `name` in `existing`, or creates it; returns the item and whether it was created.
  async function ensure(kind, name, relist, create) {
    const found = (await relist()).get(name);
    if (found) {
      out(`ok       ${kind} ${name}`);
      return found;
    }
    try {
      const made = await create();
      out(`created  ${kind} ${name}`);
      return made;
    } catch (e) {
      // The create may have been applied with its answer lost; only a fresh successful listing decides.
      const again = (await relist()).get(name);
      if (again) {
        out(`ok       ${kind} ${name} (existed after a refused create)`);
        return again;
      }
      throw e;
    }
  }

  // Zone
  const zone = await attempt("zone", async () => {
    const list = await api("GET", `/zones?name=${ZONE}&account.id=${accountId}`);
    if (!Array.isArray(list.result)) throw new Error("unrecognised zone listing");
    const z = list.result.find((x) => x.name === ZONE);
    if (!z) throw new Error(`zone ${ZONE} is not visible to this token (not "absent": nothing is created from this)`);
    return z.id;
  });
  ids.zone_id = zone;

  // Secrets Store
  const store = await attempt("secrets store", async () => {
    const list = () => listAll(acct, "/secrets_store/stores", (j) => j.result);
    const adopt = (stores) => {
      if (stores.length > 1) throw new Error(`${stores.length} Secrets Stores found; the beta allows one per account, so this is unexpected`);
      return stores[0];
    };
    const found = adopt(await list());
    if (found) {
      out(`ok       secrets-store ${found.name}`);
      return found;
    }
    try {
      const json = await acct("POST", "/secrets_store/stores", { name: plan.secretsStore });
      const made = Array.isArray(json.result) ? json.result[0] : json.result;
      if (!made?.id) throw new Error("create answered without a store id");
      out(`created  secrets-store ${plan.secretsStore}`);
      return made;
    } catch (e) {
      const again = adopt(await list());
      if (!again) throw e;
      out(`ok       secrets-store ${again.name} (existed after a refused create)`);
      return again;
    }
  });
  ids.secrets_store_id = store?.id;
  const secrets = store ? createSecretsStore({ fetch: fetchImpl, token, accountId, storeId: store.id }) : undefined;

  // D1
  ids.d1 = {};
  {
    const relist = async () => new Map((await listAll(acct, "/d1/database", (j) => j.result)).map((d) => [d.name, d]));
    for (const name of plan.d1) {
      const d = await attempt(`d1 ${name}`, () => ensure("d1", name, relist, async () => {
        const json = await acct("POST", "/d1/database", { name, primary_location_hint: opts.d1LocationHint });
        return { uuid: json.result?.uuid, name };
      }));
      if (d) ids.d1[name] = { id: d.uuid };
    }
  }

  // KV
  ids.kv = {};
  {
    const relist = async () => new Map((await listAll(acct, "/storage/kv/namespaces", (j) => j.result)).map((n) => [n.title, n]));
    for (const name of plan.kv) {
      const n = await attempt(`kv ${name}`, () => ensure("kv", name, relist, async () => {
        const json = await acct("POST", "/storage/kv/namespaces", { title: name });
        return { id: json.result?.id, title: name };
      }));
      if (n) ids.kv[name] = { id: n.id };
    }
  }

  // R2 buckets, then the setting that makes the custom domain or a Worker the only way in.
  ids.r2 = {};
  {
    const relist = async () => new Map((await listR2Buckets(acct)).map((n) => [n, { name: n }]));
    for (const name of plan.r2) {
      const b = await attempt(`r2 ${name}`, () => ensure("r2", name, relist, async () => {
        await acct("POST", "/r2/buckets", { name });
        return { name };
      }));
      if (!b) continue;
      ids.r2[name] = { r2_dev_disabled: false };
      await attempt(`r2 ${name} r2.dev access`, async () => {
        const managed = `/r2/buckets/${name}/domains/managed`;
        const state = await acct("GET", managed);
        if (typeof state.result?.enabled !== "boolean") throw new Error("unrecognised r2.dev state");
        if (state.result.enabled) {
          await acct("PUT", managed, { enabled: false });
          const after = await acct("GET", managed);
          if (after.result?.enabled !== false) throw new Error("r2.dev access is still enabled after the update");
          out(`closed   r2.dev access ${name}`);
        }
        ids.r2[name].r2_dev_disabled = true;
      });
    }
  }

  // R2 custom domains
  ids.r2_custom_domains = {};
  for (const [bucket, domain] of Object.entries(plan.r2CustomDomains)) {
    await attempt(`r2 custom domain ${domain}`, async () => {
      if (!zone) throw new Error("needs the zone id");
      const path = `/r2/buckets/${bucket}/domains/custom`;
      const relist = async () => {
        const json = await acct("GET", path);
        if (!Array.isArray(json.result?.domains)) throw new Error("unrecognised custom-domain listing");
        return new Map(json.result.domains.map((d) => [d.domain, d]));
      };
      await ensure("r2-domain", domain, relist, async () => {
        await acct("POST", path, { domain, enabled: true, zoneId: zone, minTLS: "1.2" });
        return { domain };
      });
      ids.r2_custom_domains[domain] = { bucket };
    });
  }

  // Hostnames the Workers' routes use need a proxied DNS record before a route can serve them.
  ids.hostnames = {};
  for (const host of plan.hosts) {
    await attempt(`dns ${host}`, async () => {
      if (!zone) throw new Error("needs the zone id");
      const path = `/zones/${zone}/dns_records`;
      const relist = async () => {
        const json = await api("GET", `${path}?name=${encodeURIComponent(host)}&per_page=${PER_PAGE}`);
        if (!Array.isArray(json.result)) throw new Error("unrecognised DNS listing");
        if (json.result.length >= PER_PAGE) throw new Error("cannot tell whether the DNS listing is complete");
        return new Map(json.result.map((r) => [r.name, r]));
      };
      const rec = await ensure("dns", host, relist, async () => {
        const json = await api("POST", path, { type: "AAAA", name: host, content: "100::", proxied: true, comment: "route placeholder; Workers routes serve this host" });
        return json.result ?? { name: host, proxied: true };
      });
      if (rec.proxied !== true) throw new Error(`${host} has a record that is not proxied; routes cannot serve it (left unchanged)`);
      ids.hostnames[host] = { record_id: rec.id };
    });
  }

  // Vectorize
  ids.vectorize = {};
  {
    const relist = async () => new Map((await acct("GET", "/vectorize/v2/indexes").then((j) => {
      if (!Array.isArray(j.result)) throw new Error("unrecognised Vectorize listing");
      return j.result;
    })).map((i) => [i.name, i]));
    for (const name of plan.vectorize) {
      await attempt(`vectorize ${name}`, async () => {
        const dimensions = embeddingDimensions(opts.embeddingModel);
        const v = await ensure("vectorize", name, relist, async () => {
          await acct("POST", "/vectorize/v2/indexes", { name, description: `${opts.embeddingModel} embeddings`, config: { dimensions, metric: "cosine" } });
          return { name, config: { dimensions } };
        });
        const have = v.config?.dimensions;
        if (have !== undefined && have !== dimensions) {
          throw new Error(`index exists with ${have} dimensions but ${opts.embeddingModel} produces ${dimensions}; dimensions cannot change, so this needs a new index`);
        }
        ids.vectorize[name] = { dimensions, model: opts.embeddingModel };
      });
    }
  }

  // Queues
  ids.queues = {};
  {
    const relist = async () => new Map((await listAll(acct, "/queues", (j) => j.result)).map((q) => [q.queue_name, q]));
    for (const name of plan.queues) {
      const q = await attempt(`queue ${name}`, () => ensure("queue", name, relist, async () => {
        const json = await acct("POST", "/queues", { queue_name: name });
        return { queue_id: json.result?.queue_id, queue_name: name };
      }));
      if (q) ids.queues[name] = { id: q.queue_id };
    }
  }

  // Turnstile. The secret is readable only when created, so it goes straight to the Secrets Store.
  await attempt(`turnstile ${plan.turnstile.name}`, async () => {
    if (!secrets) throw new Error("no Secrets Store to hold the widget secret; not creating the widget, because its secret is readable only when it is created");
    let created;
    const relist = async () => new Map((await listAll(acct, "/challenges/widgets", (j) => j.result)).map((w) => [w.name, w]));
    const w = await ensure("turnstile", plan.turnstile.name, relist, async () => {
      const json = await acct("POST", "/challenges/widgets", { name: plan.turnstile.name, domains: plan.turnstile.domains, mode: "managed" });
      created = json.result;
      return created;
    });
    ids.turnstile = { sitekey: w.sitekey };
    if (created?.secret) {
      if (!secrets) throw new Error("widget created but no Secrets Store to hold its secret; delete the widget and re-run");
      await secrets.create(plan.turnstile.secretName, created.secret, `Turnstile secret (${env})`);
      out(`stored   ${plan.turnstile.secretName}`);
    } else if (secrets && !(await secrets.listNames()).has(plan.turnstile.secretName)) {
      throw new Error(`widget exists but ${plan.turnstile.secretName} is not in the Secrets Store; rotate the widget secret in the dashboard and store it`);
    }
  });

  // Object-only R2 tokens
  ids.tokens = {};
  if (secrets) {
    await attempt("r2 object tokens", async () => {
      // The groups endpoint is unpaginated and returns hundreds, so each is asked for by name.
      const groupId = async (name) => {
        const json = await acct("GET", `/tokens/permission_groups?name=${encodeURIComponent(name)}`);
        if (!Array.isArray(json.result)) throw new Error("unrecognised permission group listing");
        const g = json.result.find((x) => x.name === name);
        if (!g) throw new Error(`permission group "${name}" is not offered to this token; not guessing another`);
        return g.id;
      };
      const existing = new Map((await listAll(acct, "/tokens", (j) => j.result, TOKENS_PER_PAGE)).map((t) => [t.name, t]));
      const names = await secrets.listNames();
      for (const spec of TOKEN_SPECS) {
        const bucket = suffixed(env, spec.bucket);
        const name = `packserver-${spec.key}${env === "staging" ? "-staging" : ""}`;
        const have = existing.get(name);
        if (!have && spec.handOver && !opts.printOpsToken) {
          out(`skipped  token ${name}: its value is shown once; re-run with --print-ops-token to mint it`);
          continue;
        }
        if (have) {
          const keyNames = spec.audit ? Object.values(plan.auditSecrets) : [];
          const missing = keyNames.filter((n) => !names.has(n));
          if (missing.length) throw new Error(`token ${name} (${have.id}) exists but ${missing.join(", ")} is not in the Secrets Store; revoke the token and re-run`);
          out(`ok       token ${name} (value not recoverable)`);
          ids.tokens[name] = { id: have.id, bucket };
          continue;
        }
        const permission_groups = [];
        for (const p of spec.permissions) permission_groups.push({ id: await groupId(p) });
        const json = await acct("POST", "/tokens", {
          name,
          policies: [{ effect: "allow", resources: { [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: "*" }, permission_groups }],
        });
        const { id, value } = json.result ?? {};
        if (id && !value) throw new Error(`token ${name} was created without a value; ${await revoke(id)}`);
        if (!id || !value) throw new Error(`token ${name} was created without a usable id and value`);
        const secretAccessKey = createHash("sha256").update(value).digest("hex");
        if (spec.audit) {
          try {
            await secrets.create(plan.auditSecrets.accessKeyId, id, `${name} (${env})`);
            await secrets.create(plan.auditSecrets.secretAccessKey, secretAccessKey, `${name} (${env})`);
          } catch (e) {
            throw new Error(`could not store ${name}: ${e.message}; ${await revoke(id)}`, { cause: e });
          }
          out(`created  token ${name} -> Secrets Store ${Object.values(plan.auditSecrets).join(", ")}`);
        } else {
          out(`created  token ${name}`);
          out(`${spec.handOver}_ACCESS_KEY_ID=${id}`);
          out(`${spec.handOver}_SECRET_ACCESS_KEY=${secretAccessKey}`);
          out(`${spec.handOver}_BUCKET=${bucket}`);
        }
        ids.tokens[name] = { id, bucket };
      }
    });
  }

  ids.cache_rule_needed_for = Object.values(plan.r2CustomDomains);
  return { ids, failures };
}

// An existing file that cannot be read stops the run: replacing it would drop ids found earlier.
function readPrior(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${path} is not valid JSON (${e.message}); fix or remove it, nothing was provisioned`);
  }
}

function mergeExisting(prior, ids) {
  const merged = { ...prior };
  for (const [k, v] of Object.entries(ids)) {
    if (v === undefined) continue;
    merged[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(prior[k] ?? {}), ...v } : v;
  }
  return merged;
}

export function dryRunLines(plan, opts) {
  const lines = [`[dry-run] env=${plan.env}: would create or confirm, then write infra/resources.${plan.env}.json`];
  const add = (kind, names) => names.forEach((n) => lines.push(`  ${kind.padEnd(10)} ${n}`));
  add("secrets", [plan.secretsStore]);
  add("d1", plan.d1.map((n) => `${n} (location hint ${opts.d1LocationHint})`));
  add("kv", plan.kv);
  add("r2", plan.r2.map((n) => `${n} (r2.dev access closed)`));
  add("r2-domain", Object.entries(plan.r2CustomDomains).map(([b, d]) => `${d} -> ${b}`));
  add("dns", plan.hosts);
  add("vectorize", plan.vectorize.map((n) => `${n} (${embeddingDimensions(opts.embeddingModel)} dims, ${opts.embeddingModel})`));
  add("queue", plan.queues);
  add("turnstile", [`${plan.turnstile.name} (${plan.turnstile.domains.join(", ")})`]);
  add("token", TOKEN_SPECS.map((s) => `packserver-${s.key}${plan.env === "staging" ? "-staging" : ""}: ${s.permissions.join(" + ")} on ${suffixed(plan.env, s.bucket)} only`));
  lines.push("[dry-run] no network calls made. The Cache Rule for the packs host is applied by infra/zone (T-011).");
  return lines;
}

export async function main(argv, envVars, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        env: { type: "string" },
        "dry-run": { type: "boolean" },
        "d1-location-hint": { type: "string" },
        "embedding-model": { type: "string" },
        "print-ops-token": { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (!values.env || !ENVS.includes(values.env)) {
    err(`--env <${ENVS.join("|")}> is required\n\n${USAGE}`);
    return 2;
  }
  const opts = {
    d1LocationHint: values["d1-location-hint"] ?? "enam",
    embeddingModel: values["embedding-model"] ?? DEFAULT_EMBEDDING_MODEL,
    printOpsToken: values["print-ops-token"] === true,
  };
  let plan;
  try {
    embeddingDimensions(opts.embeddingModel);
    plan = planResources(values.env, { root: deps.root ?? REPO });
  } catch (e) {
    err(e.message);
    return 2;
  }
  if (values["dry-run"]) {
    for (const l of dryRunLines(plan, opts)) out(l);
    return 0;
  }
  const path = deps.resourcesPath ?? resourcesPath(values.env);
  let prior;
  try {
    prior = readPrior(path);
  } catch (e) {
    err(e.message);
    return 2;
  }
  let cfg;
  try {
    cfg = await resolveCloudflareConfig(envVars, deps.fetch ?? fetch);
  } catch (e) {
    err(e instanceof ConfigError ? `${e.message}\n\n${USAGE}` : `failed: ${e.message}`);
    return e instanceof ConfigError ? 2 : 1;
  }
  const { ids, failures } = await provision(values.env, opts, { fetch: deps.fetch ?? fetch, token: cfg.token, accountId: cfg.accountId, out, plan });
  writeFileSync(path, `${JSON.stringify(mergeExisting(prior, ids), null, 2)}\n`);
  out(`wrote ${path}`);
  out("The packs host serves only default file types until the Cache Rule from infra/zone (T-011) is applied.");
  out("Bucket lock on audit-log is the owner's step (M-11); this script never touches it.");
  if (failures.length) {
    err(`${failures.length} resource(s) not provisioned:\n  ${failures.join("\n  ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
