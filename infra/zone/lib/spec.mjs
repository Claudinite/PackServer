// The declarative zone, Access and Logpush definitions, and the checks that keep them inside the
// Free-plan budget and consistent with the hosts the Workers are routed on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENVS, ZONE, planResources } from "../../lib/plan.mjs";
import { checkTransformer, readTemplate, renderTransformer } from "./transformer.mjs";

const DIR = join(import.meta.dirname, "..");
export const MANAGED_PREFIX = "packserver_";

const read = (name) => JSON.parse(readFileSync(join(DIR, name), "utf8"));

export function loadSpec() {
  return { rules: read("rules.json"), access: read("access.json"), logpush: read("logpush.json") };
}

const HOST_RE = new RegExp(`[a-z0-9-]+\\.${ZONE.replace(/\./g, "\\.")}`, "g");
export const hostsIn = (text) => [...new Set(text.match(HOST_RE) ?? [])].sort();

// Every public hostname of an environment: Worker route hosts plus R2 custom domains.
export function envHosts(env, root) {
  const plan = planResources(env, root ? { root } : undefined);
  return [...new Set([...plan.hosts, ...Object.values(plan.r2CustomDomains)])].sort();
}

// Dotted field names in an expression, ignoring string literals.
export const fieldsIn = (expression) =>
  [...new Set(expression.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/\b(?:http|ip|cf)\.[a-z_]+(?:\.[a-z_]+)*/g) ?? [])].sort();

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validateSpec(spec, { root } = {}) {
  const problems = [];
  const known = new Set(ENVS.flatMap((e) => envHosts(e, root)));
  const knownHost = (h, where) => {
    if (!known.has(h)) problems.push(`${where}: ${h} is not a host any Worker route or R2 custom domain serves`);
  };

  const { rules } = spec;
  for (const [phase, list] of Object.entries(rules.phases)) {
    const budget = rules.budgets[phase];
    if (!budget) problems.push(`${phase}: no Free-plan budget declared`);
    else if (list.length > budget.max) problems.push(`${phase}: ${list.length} ${budget.kind} declared, the Free plan allows ${budget.max}`);
    for (const r of list) {
      if (!r.ref?.startsWith(MANAGED_PREFIX)) problems.push(`${phase}: rule ref "${r.ref}" must start with ${MANAGED_PREFIX} so unmanaged rules are never touched`);
      if (/\bmatches\b|regex_replace|sha256/.test(r.expression)) problems.push(`${r.ref}: the Free plan has no regex or sha256 in expressions`);
      for (const h of hostsIn(r.expression)) knownHost(h, r.ref);
      const valueExpressions = Object.values(r.action_parameters?.headers ?? {}).map((h) => h.expression).filter(Boolean);
      for (const f of [r.expression, ...valueExpressions].flatMap(fieldsIn)) {
        if (!rules.freeFields.includes(f)) problems.push(`${r.ref}: field ${f} is not on the Free-plan field list (rules.json freeFields)`);
      }
    }
    const refs = list.map((r) => r.ref);
    if (new Set(refs).size !== refs.length) problems.push(`${phase}: duplicate rule refs`);
  }
  const rate = rules.phases.http_ratelimit ?? [];
  for (const r of rate) {
    if (!/^\(starts_with\(http\.request\.uri\.path, "[^"]+"\)\)$/.test(r.expression)) problems.push(`${r.ref}: a Free-plan rate rule may use only the request path`);
    const rl = r.ratelimit ?? {};
    if (!sameJson(rl.characteristics, ["cf.colo.id", "ip.src"])) problems.push(`${r.ref}: a Free-plan rate rule counts by exactly ["cf.colo.id","ip.src"]`);
    if (rl.period !== 10) problems.push(`${r.ref}: a Free-plan rate rule has a 10-second period`);
    if (rl.mitigation_timeout !== 10) problems.push(`${r.ref}: a Free-plan rate rule has a 10-second mitigation timeout`);
  }
  for (const r of rules.phases.http_request_cache_settings ?? []) {
    if (/registry/.test(r.expression)) problems.push(`${r.ref}: no Cache Rule may touch a registry host (REQ-DELIV-013)`);
  }

  const { access } = spec;
  const adminApps = access.applications.filter((a) => a.adminIdpOnly);
  const policiesOf = (a) => a.policies;
  if (adminApps.length !== ENVS.length || new Set(adminApps.map((a) => a.env)).size !== ENVS.length) problems.push("each environment needs exactly one admin application");
  if (adminApps.length > 1 && !adminApps.every((a) => sameJson(policiesOf(a), policiesOf(adminApps[0])) && a.sessionDuration === adminApps[0].sessionDuration)) {
    problems.push("the admin applications must mirror each other exactly");
  }
  if (access.applications.length > access.maxApplications) problems.push(`${access.applications.length} Access applications declared, the plan allows ${access.maxApplications}`);
  const names = access.applications.map((a) => a.name);
  if (new Set(names).size !== names.length) problems.push("duplicate Access application names");
  const roles = new Set(access.serviceTokens.map((t) => t.role));
  for (const a of access.applications) {
    if (!ENVS.includes(a.env)) problems.push(`${a.name}: env must be one of ${ENVS.join(", ")}`);
    for (const d of a.destinations) knownHost(d.split("/")[0], a.name);
    for (const p of a.policies) {
      if (!["allow", "non_identity", "bypass"].includes(p.decision)) problems.push(`${a.name}/${p.name}: unsupported decision ${p.decision}`);
      for (const inc of p.include) {
        if (inc.serviceToken && !roles.has(inc.serviceToken)) problems.push(`${a.name}/${p.name}: unknown service token role ${inc.serviceToken}`);
        if (p.decision === "bypass" && !inc.everyone) problems.push(`${a.name}/${p.name}: a Bypass policy admits everyone and nothing narrower`);
      }
      if (p.decision === "non_identity" && p.include.some((i) => !i.serviceToken)) problems.push(`${a.name}/${p.name}: a Service Auth policy admits service tokens only`);
    }
    if (a.adminIdpOnly && a.policies.some((p) => p.include.some((i) => i.serviceToken))) problems.push(`${a.name}: the admin application admits no service token`);
  }

  const { logpush } = spec;
  for (const j of logpush.jobs) {
    if (!(j.sampleRate > 0 && j.sampleRate <= 1)) problems.push(`${j.key}: sampleRate must be in (0, 1]`);
    for (const f of j.fields) {
      if (logpush.forbiddenFields.includes(f)) problems.push(`${j.key}: field ${f} would put a raw IP or query string in the archive`);
    }
    if (j.dataset === "http_requests" && !j.transformer) problems.push(`${j.key}: an http_requests job must go through the transformer, or ClientIP reaches the archive`);
    if (j.transformer) {
      if (!j.where || !["hit", "miss"].includes(j.previewCacheStatus)) problems.push(`${j.key}: a transformer job needs a SQL where and a previewCacheStatus`);
      else {
        const sql = renderTransformer(readTemplate(spec, j), j, envHosts("staging", root));
        if (sql.length > 32768) problems.push(`${j.key}: the transformer SQL is over the 32768-character maxLength of the transformer API schema (the docs say 250 KB; the schema is the stricter, so it is the one checked)`);
        problems.push(...checkTransformer(sql, logpush.vectors, logpush.forbiddenFields).map((p) => `${j.key}: ${p}`));
      }
    }
    const retained = logpush.retention.some((r) => j.prefix.startsWith(r.prefix));
    if (!retained) problems.push(`${j.key}: no retention rule covers ${j.prefix}`);
  }
  return problems;
}

export const appsFor = (spec, env) => spec.access.applications.filter((a) => a.env === env);
export const tokensFor = (spec, env) => spec.access.serviceTokens.filter((t) => t.env === env);
