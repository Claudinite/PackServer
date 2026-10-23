import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./apply.mjs";
import { fakeZone } from "./fake-zone.mjs";
import { loadSpec, validateSpec } from "./lib/spec.mjs";
import { tokenSecretNames } from "./lib/access.mjs";

const BASE_ENV = {
  CF_BOOTSTRAP_TOKEN: "t",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  ACCESS_TEAM_EMAILS: "a@example.com,b@example.com",
  ACCESS_ADMIN_EMAILS: "admin@example.com",
  ACCESS_ADMIN_IDP_ID: "idp-hw",
  CF_LOGPUSH_R2_ACCESS_KEY_ID: "key",
  CF_LOGPUSH_R2_SECRET_ACCESS_KEY: "secret",
};

async function run(argv, zone, { env = BASE_ENV, ...deps } = {}) {
  const out = [];
  const err = [];
  const backupDir = mkdtempSync(join(tmpdir(), "zone-"));
  const code = await main(argv, env, { fetch: zone?.fetch, out: (s) => out.push(s), err: (s) => err.push(s), backupDir, now: () => "2026-10-23T01:02:03.000Z", ...deps });
  return { code, out: out.join("\n"), err: err.join("\n"), backupDir };
}

const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
// Both runs of a staging rollout; their outputs and errors are joined for the never-printed checks.
async function converge(zone, env) {
  const a = await run(["--zone", "--apply"], zone);
  const b = await run(["--env", env, "--apply"], zone);
  return { code: a.code || b.code, out: `${a.out}\n${b.out}`, err: `${a.err}\n${b.err}`.trim(), backupDir: a.backupDir };
}
const clone = () => structuredClone(loadSpec());
const rulesOf = (zone, phase) => zone.state.rulesets[phase].rules;

describe("the declarations", () => {
  const spec = loadSpec();

  it("are valid and spend the Free-plan budget as the trust table says", () => {
    expect(validateSpec(spec)).toEqual([]);
    expect(spec.rules.phases.http_request_late_transform).toHaveLength(2);
    expect(spec.rules.phases.http_request_firewall_custom).toHaveLength(1);
    expect(spec.rules.phases.http_request_cache_settings).toHaveLength(1);
    expect(spec.rules.phases.http_ratelimit).toHaveLength(1);
    expect(spec.access.applications).toHaveLength(7);
    expect(spec.logpush.jobs.filter((j) => j.dataset === "http_requests").map((j) => j.sampleRate).sort()).toEqual([0.1, 1]);
  });

  it("strip the four edge headers on the registry and packs hosts, unconditionally", () => {
    const strip = spec.rules.phases.http_request_late_transform[0];
    expect(Object.keys(strip.action_parameters.headers).sort()).toEqual([
      "Cloudflare-Workers-Version-Key",
      "Cloudflare-Workers-Version-Overrides",
      "X-PackServer-Shadow",
      "X-Selftest-Signature",
    ]);
    expect(strip.expression).toBe('(http.host in {"registry.claudinite.com" "packs.claudinite.com"})');
    for (const h of Object.values(strip.action_parameters.headers)) expect(h).toEqual({ operation: "remove" });
  });

  it("confine /hooks/* to the production and staging registry hosts", () => {
    const [waf] = spec.rules.phases.http_request_firewall_custom;
    expect(waf.action).toBe("block");
    expect(waf.expression).toContain('"registry.claudinite.com" "registry-staging.claudinite.com"');
    expect(waf.expression).toContain('starts_with(http.request.uri.path, "/hooks/")');
  });

  it("leave registry hosts out of every Cache Rule and make packs cacheable by origin headers", () => {
    const [cache] = spec.rules.phases.http_request_cache_settings;
    expect(cache.expression).not.toContain("registry");
    expect(cache.action_parameters).toEqual({ cache: true, edge_ttl: { mode: "respect_origin" } });
    expect(spec.rules.smartTieredCache).toBe(true);
  });

  it("rate-limit /api/auth/* by path with the Free-plan characteristics, period and timeout", () => {
    const [rate] = spec.rules.phases.http_ratelimit;
    expect(rate.expression).toBe('(starts_with(http.request.uri.path, "/api/auth/"))');
    expect(rate.ratelimit).toMatchObject({ characteristics: ["cf.colo.id", "ip.src"], period: 10, mitigation_timeout: 10 });
  });

  it("set the version key from the client IP on the registry host only, with Free-plan fields", () => {
    const set = spec.rules.phases.http_request_late_transform[1];
    expect(set.expression).toBe('(http.host eq "registry.claudinite.com")');
    expect(set.action_parameters.headers["Cloudflare-Workers-Version-Key"]).toEqual({ operation: "set", expression: "to_string(ip.src)" });
  });

  it("mirror the production admin application on the staging admin host, which staging-hosts does not cover", () => {
    const admin = spec.access.applications.find((a) => a.name === "packserver-admin");
    const staging = spec.access.applications.find((a) => a.name === "packserver-staging-admin");
    expect(staging).toMatchObject({ env: "staging", destinations: ["registry-admin-staging.claudinite.com"], adminIdpOnly: true, policies: admin.policies, sessionDuration: admin.sessionDuration });
    const hosts = spec.access.applications.find((a) => a.name === "packserver-staging-hosts");
    expect(hosts.destinations).not.toContain("registry-admin-staging.claudinite.com");
    expect(hosts.destinations).toContain("registry-admin-staging.claudinite.com/__selftest*");
  });

  it("have a Bypass on the staging webhook path and keep service tokens out of the admin application", () => {
    const bypass = spec.access.applications.find((a) => a.destinations.includes("registry-staging.claudinite.com/hooks/*"));
    expect(bypass.policies.map((p) => p.decision)).toEqual(["bypass"]);
    const admin = spec.access.applications.find((a) => a.name === "packserver-admin");
    expect(JSON.stringify(admin)).not.toContain("serviceToken");
    expect(admin.adminIdpOnly).toBe(true);
  });

  it("refuse a Free-plan count that is exceeded, regex, a registry Cache Rule and unknown hosts", () => {
    const over = clone();
    over.rules.phases.http_ratelimit.push({ ...over.rules.phases.http_ratelimit[0], ref: "packserver_second_rate" });
    expect(validateSpec(over).join()).toContain("allows 1");

    const regex = clone();
    regex.rules.phases.http_request_firewall_custom[0].expression = '(http.request.uri.path matches "^/hooks/")';
    expect(validateSpec(regex).join()).toContain("no regex");

    const reg = clone();
    reg.rules.phases.http_request_cache_settings[0].expression = '(http.host eq "registry.claudinite.com")';
    expect(validateSpec(reg).join()).toContain("REQ-DELIV-013");

    const host = clone();
    host.access.applications[0].destinations = ["nowhere.claudinite.com"];
    expect(validateSpec(host).join()).toContain("nowhere.claudinite.com");

    const pro = clone();
    pro.rules.phases.http_request_late_transform[1].action_parameters.headers["Cloudflare-Workers-Version-Key"].expression = 'http.request.cookies["__Host-session"][0]';
    expect(validateSpec(pro).join()).toContain("http.request.cookies is not on the Free-plan field list");
    const proMatch = clone();
    proMatch.rules.phases.http_request_firewall_custom[0].expression = "(cf.bot_management.score lt 30)";
    expect(validateSpec(proMatch).join()).toContain("cf.bot_management.score");

    const rate = clone();
    rate.rules.phases.http_ratelimit[0].ratelimit.characteristics = ["ip.src"];
    expect(validateSpec(rate).join()).toContain('exactly ["cf.colo.id","ip.src"]');
    rate.rules.phases.http_ratelimit[0].ratelimit = { characteristics: ["cf.colo.id", "ip.src"], period: 60, mitigation_timeout: 600 };
    expect(validateSpec(rate).join()).toContain("10-second period");

    const drift = clone();
    drift.access.applications.find((a) => a.name === "packserver-staging-admin").sessionDuration = "24h";
    expect(validateSpec(drift).join()).toContain("mirror each other");

    const foreign = clone();
    foreign.rules.phases.http_request_late_transform[0].ref = "strip";
    expect(validateSpec(foreign).join()).toContain("must start with");
  });

  it("keep raw IPs and query strings out of the Logpush archive and give every prefix a retention", () => {
    const bad = clone();
    bad.logpush.jobs[0].fields.push("ClientIP");
    expect(validateSpec(bad).join()).toContain("ClientIP");
    const uncovered = clone();
    uncovered.logpush.retention.pop();
    expect(validateSpec(uncovered).join()).toContain("no retention rule");
    for (const j of spec.logpush.jobs) expect(j.fields.join()).not.toMatch(/ClientIP\b|URI|Query/);
  });
});

describe("the command", () => {
  it("validates offline by default and touches no network", async () => {
    const r = await run(["--env", "staging"], undefined, { fetch: () => { throw new Error("network used"); } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("packserver-staging-hooks-bypass");
    expect(r.out).toContain("nothing was read or changed");
  });

  it("--plan reads the account and writes nothing", async () => {
    const zone = fakeZone();
    const r = await run(["--zone", "--env", "staging", "--plan"], zone);
    expect(r.code).toBe(0);
    expect(zone.writes()).toEqual([]);
    expect(r.out).toContain("would    update Transform Rules");
    expect(r.out).toContain("would    create service token packserver-ci-staging");
    expect(r.out).toContain("would    create access application packserver-staging-hosts");
  });

  it("--apply on staging converges, and a second run changes nothing", async () => {
    const zone = fakeZone();
    const first = await converge(zone, "staging");
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(rulesOf(zone, "http_request_late_transform").map((r) => r.ref)).toHaveLength(2);
    expect(rulesOf(zone, "http_request_firewall_custom")[0].action).toBe("block");
    expect(zone.state.tiered).toBe("on");
    expect(zone.state.apps.map((a) => a.name).sort()).toEqual(["packserver-staging-admin", "packserver-staging-hooks-bypass", "packserver-staging-hosts"]);
    expect(zone.state.jobs.map((j) => j.name).sort()).toEqual([
      "packserver-staging-firewall-events",
      "packserver-staging-http-cache-hits",
      "packserver-staging-http-cache-misses",
    ]);
    expect(zone.state.lifecycle["ops-staging"].rules).toHaveLength(2);

    const writesAfterFirst = zone.writes().length;
    const second = await converge(zone, "staging");
    expect(second.code).toBe(0);
    expect(zone.writes()).toHaveLength(writesAfterFirst);
    expect(second.out).not.toMatch(/^(created|updated|saved)/m);
  });

  it("stores a service token's secret in the Secrets Store and never prints it", async () => {
    const zone = fakeZone();
    const r = await converge(zone, "staging");
    const names = tokenSecretNames("staging", "ci");
    expect(Object.keys(zone.inner.state.secretValues)).toEqual(expect.arrayContaining([names.clientId, names.clientSecret]));
    const secret = zone.inner.state.secretValues[names.clientSecret];
    expect(secret).toBeTruthy();
    expect(r.out).not.toContain(secret);
    expect(r.err).not.toContain(secret);
    for (const f of readdirSync(r.backupDir)) expect(readFileSync(join(r.backupDir, f), "utf8")).not.toContain(secret);
  });

  it("the staging Bypass covers the webhook path and the staging-hosts application does not exempt it", async () => {
    const zone = fakeZone();
    await run(["--env", "staging", "--apply", "--only", "access"], zone);
    const bypass = zone.state.apps.find((a) => a.name === "packserver-staging-hooks-bypass");
    expect(bypass.destinations).toEqual([{ type: "public", uri: "registry-staging.claudinite.com/hooks/*" }]);
    expect(bypass.policies[0]).toMatchObject({ decision: "bypass", include: [{ everyone: {} }] });
  });

  it("keeps unmanaged rules, saves the previous rule set, and refuses to exceed the budget", async () => {
    const foreign = { id: "foreign", ref: "website_rule", action: "rewrite", expression: "(http.host eq \"claudinite.com\")", enabled: true };
    const zone = fakeZone({ seed: { rulesets: { http_request_late_transform: { id: "rs-t", phase: "http_request_late_transform", rules: [foreign] } } } });
    const r = await run(["--zone", "--apply"], zone);
    expect(r.code).toBe(0);
    expect(rulesOf(zone, "http_request_late_transform").map((x) => x.ref)).toEqual(["website_rule", ...loadSpec().rules.phases.http_request_late_transform.map((x) => x.ref)]);
    const saved = readdirSync(r.backupDir);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain("http_request_late_transform");
    expect(JSON.parse(readFileSync(join(r.backupDir, saved[0]), "utf8")).rules).toEqual([foreign]);

    const full = fakeZone({ seed: { rulesets: { http_ratelimit: { id: "rs-r", phase: "http_ratelimit", rules: [{ id: "x", ref: "website_limit", action: "block", expression: "(true)" }] } } } });
    const over = await run(["--zone", "--apply"], full);
    expect(over.code).toBe(1);
    expect(over.out).toContain("over the Free-plan limit of 1");
    expect(rulesOf(full, "http_ratelimit").map((x) => x.ref)).toEqual(["website_limit"]);
  });

  it("does not treat a failed ruleset read as an absent ruleset", async () => {
    const zone = fakeZone({ failGet: ["/rulesets/phases/http_ratelimit/entrypoint"] });
    const r = await run(["--zone", "--apply"], zone);
    expect(r.code).toBe(1);
    expect(zone.state.rulesets.http_ratelimit).toBeUndefined();
    expect(zone.calls.filter((c) => c.method === "POST" && c.body?.phase === "http_ratelimit")).toEqual([]);
  });

  it("does not create an Access application when the application listing failed", async () => {
    const zone = fakeZone({ failGet: ["/access/apps"] });
    const r = await run(["--env", "staging", "--apply", "--only", "access"], zone);
    expect(r.code).toBe(1);
    expect(zone.state.apps).toEqual([]);
  });

  it("fails when a service token exists but its secret is not stored, and creates nothing for it", async () => {
    const zone = fakeZone({ seed: { tokens: [{ id: "tok-old", name: "packserver-ci-staging" }] } });
    const r = await run(["--env", "staging", "--apply", "--only", "access"], zone);
    expect(r.code).toBe(1);
    expect(r.err).toContain("packserver-ci-staging");
    expect(zone.calls.filter((c) => c.path.endsWith("/service_tokens") && c.method === "POST")).toEqual([]);
  });

  it("production needs the identity provider id from M-03 and never guesses it", async () => {
    const zone = fakeZone();
    const env = without(BASE_ENV, "ACCESS_ADMIN_IDP_ID");
    const r = await run(["--env", "production", "--apply", "--only", "access"], zone, { env });
    expect(r.code).toBe(2);
    expect(r.err).toContain("ACCESS_ADMIN_IDP_ID");
    expect(r.err).toContain("M-03");
    expect(zone.calls).toEqual([]);
  });

  it("refuses an identity provider the account does not have, and One-time PIN", async () => {
    const unknown = fakeZone({ idps: [{ id: "other", name: "Other", type: "saml" }] });
    const a = await run(["--env", "production", "--apply", "--only", "access"], unknown);
    expect(a.code).toBe(1);
    expect(a.err).toContain("idp-hw");
    expect(unknown.state.apps).toEqual([]);

    const pin = fakeZone({ idps: [{ id: "idp-hw", name: "PIN", type: "onetimepin" }] });
    const b = await run(["--env", "production", "--apply", "--only", "access"], pin);
    expect(b.code).toBe(1);
    expect(b.err).toContain("One-time PIN");
    expect(pin.state.apps).toEqual([]);
  });

  it("production binds the admin application to the hardware-key provider alone, with no service token", async () => {
    const zone = fakeZone();
    const r = await run(["--env", "production", "--apply", "--only", "access"], zone);
    expect(r.err).toBe("");
    expect(zone.state.apps.map((a) => a.name).sort()).toEqual(["packserver-admin", "packserver-canary", "packserver-gates", "packserver-selftest"]);
    const admin = zone.state.apps.find((a) => a.name === "packserver-admin");
    expect(admin.allowed_idps).toEqual(["idp-hw"]);
    expect(admin.auto_redirect_to_identity).toBe(true);
    expect(JSON.stringify(admin.policies)).not.toContain("service_token");
    const canary = zone.state.apps.find((a) => a.name === "packserver-canary");
    expect(canary.policies.find((p) => p.decision === "non_identity").include).toHaveLength(2);
    const selftest = zone.state.apps.find((a) => a.name === "packserver-selftest");
    expect(selftest.destinations.map((d) => d.uri)).toContain("registry-admin.claudinite.com/__selftest*");
  });

  it("scopes each environment's Logpush jobs to its own hosts and ops bucket, with no raw IP field", async () => {
    const zone = fakeZone();
    await run(["--env", "production", "--apply", "--only", "logpush"], zone);
    const hits = zone.state.jobs.find((j) => j.name === "packserver-production-http-cache-hits");
    expect(hits.output_options.sample_rate).toBe(0.1);
    expect(hits.destination_conf).toContain("r2://ops/logs/http-requests/hits/{DATE}");
    const filter = JSON.parse(hits.filter).where.and;
    expect(filter[0].value).toEqual(expect.arrayContaining(["registry.claudinite.com", "packs.claudinite.com"]));
    expect(filter[0].value).not.toContain("registry-staging.claudinite.com");
    expect(filter[1]).toEqual({ key: "CacheCacheStatus", operator: "eq", value: "hit" });
    const misses = zone.state.jobs.find((j) => j.name === "packserver-production-http-cache-misses");
    expect(misses.output_options.sample_rate).toBe(1);
    expect(JSON.parse(misses.filter).where.and[1].operator).toBe("!eq");
    for (const j of zone.state.jobs) expect(j.output_options.field_names).not.toContain("ClientIP");
  });

  it("keeps other lifecycle rules on the ops bucket", async () => {
    const other = { id: "releases", enabled: true, conditions: { prefix: "releases/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 100 } } };
    const zone = fakeZone({ seed: { lifecycle: { "ops-staging": { rules: [other] } } } });
    await run(["--env", "staging", "--apply", "--only", "logpush"], zone);
    const rules = zone.state.lifecycle["ops-staging"].rules;
    expect(rules[0]).toEqual(other);
    expect(rules.map((r) => r.conditions.prefix)).toEqual(["releases/", "logs/http-requests/", "logs/firewall-events/"]);
    expect(rules[1].deleteObjectsTransition.condition.maxAge).toBe(90 * 86400);
    expect(rules[2].deleteObjectsTransition.condition.maxAge).toBe(30 * 86400);
  });

  it("applying logpush without an R2 key stops before any call, and no run touches DNS", async () => {
    const zone = fakeZone();
    const env = without(BASE_ENV, "CF_LOGPUSH_R2_ACCESS_KEY_ID");
    const r = await run(["--env", "staging", "--apply", "--only", "logpush"], zone, { env });
    expect(r.code).toBe(2);
    expect(zone.calls).toEqual([]);

    const full = fakeZone();
    await run(["--env", "production", "--apply"], full);
    await run(["--env", "staging", "--apply"], full);
    expect(full.inner.calls.filter((c) => c.path.includes("dns_records"))).toEqual([]);
  });

  it("--env alone never touches the edge rules, and --zone alone needs no Access or Logpush input", async () => {
    const zone = fakeZone();
    await run(["--env", "staging", "--apply"], zone);
    expect(zone.calls.filter((c) => c.path.includes("/rulesets") || c.path.includes("/cache/"))).toEqual([]);

    const only = fakeZone();
    const r = await run(["--zone", "--apply"], only, { env: { CF_BOOTSTRAP_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" } });
    expect(r.code).toBe(0);
    expect(only.calls.filter((c) => c.path.includes("/access") || c.path.includes("/logpush"))).toEqual([]);
    expect(Object.keys(only.state.rulesets).sort()).toEqual(["http_ratelimit", "http_request_cache_settings", "http_request_firewall_custom", "http_request_late_transform"]);
  });

  it("a rules failure does not skip Access, and both are reported", async () => {
    const zone = fakeZone({ failGet: ["/rulesets/phases/http_ratelimit/entrypoint"] });
    const r = await run(["--zone", "--env", "staging", "--apply"], zone);
    expect(r.code).toBe(1);
    expect(zone.state.apps).toHaveLength(3);
    expect(zone.state.jobs).toHaveLength(3);
    expect(r.err).toContain("http_ratelimit");
  });

  it("rolls back a half-stored service token and says what is left", async () => {
    const zone = fakeZone({ failSecretNumber: 2 });
    const r = await run(["--env", "staging", "--apply", "--only", "access"], zone);
    const names = tokenSecretNames("staging", "ci");
    expect(r.code).toBe(1);
    expect(zone.state.tokens).toEqual([]);
    expect(zone.inner.state.secrets).not.toContain(names.clientId);
    expect(r.err).toContain("the token was deleted");
    expect(r.err).toContain("nothing was left in the Secrets Store");
  });

  it("sends unmanaged rules back without their read-only fields", async () => {
    const foreign = { id: "foreign", version: "3", last_updated: "2025-01-01T00:00:00Z", ref: "website_rule", action: "rewrite", expression: "(true)", enabled: true };
    const zone = fakeZone({ seed: { rulesets: { http_request_late_transform: { id: "rs-t", phase: "http_request_late_transform", rules: [foreign] } } } });
    await run(["--zone", "--apply"], zone);
    const put = zone.calls.find((c) => c.method === "PUT" && c.path === "/zones/zone1/rulesets/rs-t");
    expect(put.body.rules[0]).toEqual({ ref: "website_rule", action: "rewrite", expression: "(true)", enabled: true });
  });

  it("treats fields the API adds to our rules as converged", async () => {
    const [rule] = loadSpec().rules.phases.http_ratelimit;
    const served = { ...rule, id: "r1", version: "1", last_updated: "x", enabled: true, logging: { enabled: true }, ratelimit: { ...rule.ratelimit, requests_to_origin: false, counting_expression: "" } };
    const zone = fakeZone({ seed: { rulesets: { http_ratelimit: { id: "rs-r", phase: "http_ratelimit", rules: [served] } } } });
    const r = await run(["--zone", "--apply"], zone);
    expect(r.out).toContain("ok       Rate limiting rules");
    expect(zone.calls.filter((c) => c.path.includes("rs-r") && c.method !== "GET")).toEqual([]);
  });

  it("counts the other Transform phases against the same Free-plan 10", async () => {
    const others = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, ref: `site_${i}`, action: "rewrite", expression: "(true)" }));
    const zone = fakeZone({ seed: { rulesets: { http_response_headers_transform: { id: "rs-o", phase: "http_response_headers_transform", rules: others } } } });
    const r = await run(["--zone", "--apply"], zone);
    expect(r.code).toBe(1);
    expect(r.out).toContain("over the Free-plan limit of 10");
    expect(zone.state.rulesets.http_request_late_transform).toBeUndefined();
  });

  it("needs a token and an explicit mode", async () => {
    const noToken = await run(["--env", "staging", "--plan"], fakeZone(), { env: {} });
    expect(noToken.code).toBe(2);
    const both = await run(["--env", "staging", "--plan", "--apply"], fakeZone());
    expect(both.code).toBe(2);
  });
});
