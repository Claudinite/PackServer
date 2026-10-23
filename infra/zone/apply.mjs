#!/usr/bin/env node
// Applies the zone rules, Access applications and Logpush jobs declared in this folder.
//
//   (no mode)  validates the declarations offline and prints what they define; no network
//   --plan     reads the account and reports what --apply would change; writes nothing
//   --apply    makes the changes
//
// Nothing is created from a listing that failed or was read only in part. Rule sets keep every
// rule this folder does not own, and the previous rule set of a phase is saved before it changes.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ConfigError, call, createSecretsStore, resolveCloudflareConfig } from "../lib/secrets-store.mjs";
import { ENVS, ZONE } from "../lib/plan.mjs";
import { appsFor, envHosts, loadSpec, tokensFor, validateSpec } from "./lib/spec.mjs";
import { countRules, ensurePhase, ensureSmartTieredCache } from "./lib/rulesets.mjs";
import { ensureAccess, readAccessConfig } from "./lib/access.mjs";
import { ensureLogpush, readLogpushCredentials } from "./lib/logpush.mjs";
import { FAILED, PENDING, verifyDelivery } from "./lib/delivery.mjs";

export const SECTIONS = ["access", "logpush"];
const DEFAULT_BACKUP_DIR = join(import.meta.dirname, "previous");

const USAGE = `Usage: node infra/zone/apply.mjs [--env <staging|production>] [--zone] [--plan | --apply]
                              [--only <access,logpush>] [--backup-dir <dir>]
       node infra/zone/apply.mjs --env <staging|production> --verify-delivery [--verify-wait <seconds>]

  (default)     validate the declarations offline and print them
  --plan        read the account and report the changes --apply would make
  --apply       make the changes
  --zone        the zone-wide rules (Transform, WAF, Cache, rate limit, Smart Tiered Cache); never implied by --env
  --only        limit --env to some sections (default: access and logpush)
  --verify-delivery  read back the latest object each http_requests job delivered to R2 and assert
                ClientNetwork is present, ClientIP absent and the rollup's fields non-null (needs the
                token's R2 read). Also runs after an --apply of the logpush section, using only objects
                delivered since that apply. A job with no object yet is reported "not yet delivered",
                never as a pass, and the exit code is 3.
  --verify-wait seconds to keep polling for a first object (default 180; 0 checks once)
  --backup-dir  where the previous rule set of each changed phase is saved (default infra/zone/previous)

Zone rules name both environments' hosts and take effect on production the moment they are
applied, so they run only with --zone. Rollout order:
  1. --env staging --apply     staging Access applications, service token and Logpush jobs
  2. --zone --apply            the zone rules, once staging is verified
  3. --env production --apply  production Access applications, service tokens and Logpush jobs
Access applications, service tokens and Logpush jobs are those of the chosen --env.

Requires CF_BOOTSTRAP_TOKEN (CLOUDFLARE_ACCOUNT_ID when the token sees several accounts).
  access:   ACCESS_TEAM_EMAILS; for production also ACCESS_ADMIN_IDP_ID (manual task M-03, #101)
            and ACCESS_ADMIN_EMAILS
  logpush:  CF_LOGPUSH_R2_ACCESS_KEY_ID and CF_LOGPUSH_R2_SECRET_ACCESS_KEY (R2 object write on the ops bucket);
            the token needs Logs Write for the Transformers API. --plan and --apply preview each
            http_requests transformer in Cloudflare against IPv4 and IPv6 vectors first.
`;

export function describe(spec, env, zoneRules) {
  const lines = [];
  if (zoneRules) {
    lines.push("zone-wide rules:");
    for (const [phase, rules] of Object.entries(spec.rules.phases)) {
      lines.push(`  ${spec.rules.budgets[phase].kind} (${rules.length} of ${spec.rules.budgets[phase].max}): ${rules.map((r) => r.ref).join(", ")}`);
    }
  }
  if (!env) return lines;
  lines.push(`env=${env}`);
  lines.push(`  access applications: ${appsFor(spec, env).map((a) => a.name).join(", ") || "(none)"}`);
  lines.push(`  service tokens: ${tokensFor(spec, env).map((t) => t.name).join(", ") || "(none)"}`);
  lines.push(`  logpush jobs: ${spec.logpush.jobs.map((j) => `${j.dataset}/${j.key}`).join(", ")} -> ${spec.logpush.destinationBucket}`);
  return lines;
}

export async function main(argv, envVars, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { env: { type: "string" }, "verify-delivery": { type: "boolean" }, "verify-wait": { type: "string" }, zone: { type: "boolean" }, plan: { type: "boolean" }, apply: { type: "boolean" }, only: { type: "string" }, "backup-dir": { type: "string" }, help: { type: "boolean" } },
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
  if (values.env !== undefined && !ENVS.includes(values.env)) {
    err(`--env takes ${ENVS.join(" or ")}\n\n${USAGE}`);
    return 2;
  }
  if (!values.env && !values.zone) {
    err(`give --env <${ENVS.join("|")}>, --zone, or both\n\n${USAGE}`);
    return 2;
  }
  if (values["verify-delivery"] && (!values.env || values.plan || values.zone || values.only)) {
    err(`--verify-delivery takes --env alone, or rides on --apply\n\n${USAGE}`);
    return 2;
  }
  const waitSeconds = values["verify-wait"] === undefined ? 180 : Number(values["verify-wait"]);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    err(`--verify-wait takes a number of seconds\n\n${USAGE}`);
    return 2;
  }
  if (!values.env && values.only) {
    err(`--only limits --env sections; give --env\n\n${USAGE}`);
    return 2;
  }
  if (values.plan && values.apply) {
    err(`--plan and --apply are exclusive\n\n${USAGE}`);
    return 2;
  }
  const only = values.env ? (values.only ? values.only.split(",") : SECTIONS) : [];
  if (only.some((s) => !SECTIONS.includes(s))) {
    err(`--only takes ${SECTIONS.join(", ")}\n\n${USAGE}`);
    return 2;
  }
  const env = values.env;
  const zoneRules = values.zone === true;
  const spec = deps.spec ?? loadSpec();
  const problems = validateSpec(spec, { root: deps.root });
  if (problems.length) {
    err(`the declarations are invalid:\n  ${problems.join("\n  ")}`);
    return 2;
  }
  const verifyOnly = values["verify-delivery"] === true && !values.apply;
  if (!values.plan && !values.apply && !verifyOnly) {
    for (const l of describe(spec, env, zoneRules)) out(l);
    out("validated offline; nothing was read or changed. Use --plan to compare with the account, --apply to change it.");
    return 0;
  }
  const write = values.apply === true;
  const verify = (since) => verifyDelivery({ fetchImpl, token: cfg.token, accountId: cfg.accountId, env, spec, since, waitMs: waitSeconds * 1000, intervalMs: deps.verifyIntervalMs, sleep: deps.sleep, now: deps.nowMs, out });

  let accessCfg;
  let logpushCreds;
  try {
    if (verifyOnly) {
      // Reading R2 back needs only the token.
    } else if (only.includes("access")) accessCfg = readAccessConfig(envVars, spec, env);
    if (!verifyOnly && only.includes("logpush") && write) logpushCreds = readLogpushCredentials(envVars);
  } catch (e) {
    err(e instanceof ConfigError ? `${e.message}\n\n${USAGE}` : e.message);
    return 2;
  }
  let cfg;
  const fetchImpl = deps.fetch ?? fetch;
  try {
    cfg = await resolveCloudflareConfig(envVars, fetchImpl);
  } catch (e) {
    err(e instanceof ConfigError ? `${e.message}\n\n${USAGE}` : `failed: ${e.message}`);
    return e instanceof ConfigError ? 2 : 1;
  }
  const api = (method, path, body) => call(fetchImpl, cfg.token, method, path, body);
  if (verifyOnly) {
    const results = await verify(undefined);
    if (results.some((r) => r.state === FAILED)) return 1;
    return results.some((r) => r.state === PENDING) ? 3 : 0;
  }
  const failures = [];
  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
      out(`FAILED ${label}: ${e.message}`);
    }
  };

  let zoneId;
  try {
    const list = await api("GET", `/zones?name=${ZONE}&account.id=${cfg.accountId}`);
    if (!Array.isArray(list.result)) throw new Error("unrecognised zone listing");
    zoneId = list.result.find((z) => z.name === ZONE)?.id;
    if (!zoneId) throw new Error(`zone ${ZONE} is not visible to this token (not "absent": nothing is created from this)`);
  } catch (e) {
    err(`zone: ${e.message}`);
    return 1;
  }

  const applyStarted = (deps.nowMs ?? Date.now)();
  out(`${write ? "applying" : "planning"} ${[zoneRules && "zone rules", env && `env=${env} (${only.join(", ")})`].filter(Boolean).join(" and ")}`);
  if (zoneRules) {
    const backupDir = values["backup-dir"] ?? deps.backupDir ?? DEFAULT_BACKUP_DIR;
    const now = deps.now ?? (() => new Date().toISOString());
    for (const [phase, desired] of Object.entries(spec.rules.phases)) {
      await attempt(phase, async () => {
        const budget = spec.rules.budgets[phase];
        let otherRules = 0;
        for (const other of budget.alsoCounts ?? []) otherRules += await countRules(api, zoneId, other);
        await ensurePhase({ api, zoneId, phase, desired, budget, write, out, backupDir, now, otherRules });
      });
    }
    if (spec.rules.smartTieredCache) await attempt("smart tiered cache", () => ensureSmartTieredCache({ api, zoneId, write, out }));
  }
  if (only.includes("access")) {
    const secrets = createSecretsStore({ fetch: fetchImpl, token: cfg.token, accountId: cfg.accountId, storeId: cfg.storeId });
    await ensureAccess({ api, accountId: cfg.accountId, env, spec, cfg: accessCfg, secrets, write, out, failures });
  }
  if (only.includes("logpush")) {
    await ensureLogpush({ api, accountId: cfg.accountId, zoneId, env, spec, hosts: envHosts(env, deps.root), creds: logpushCreds, write, out, failures });
  }
  if (failures.length) {
    err(`${failures.length} item(s) not converged:\n  ${failures.join("\n  ")}`);
    return 1;
  }
  if (write && only.includes("logpush")) {
    const results = await verify(applyStarted);
    if (results.some((r) => r.state === FAILED)) {
      err("delivery check failed: the transformer jobs deliver records that do not match the SQL's assumptions");
      return 1;
    }
    if (results.some((r) => r.state === PENDING)) return 3;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
