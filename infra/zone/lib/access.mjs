// Access service tokens, the team group and the applications, converged on the declared set.
// Creation happens only after a listing that succeeded and was read to its last page lacks the name.
import { listAll } from "../../provision.mjs";
import { ConfigError, secretPrefix } from "../../lib/secrets-store.mjs";
import { same } from "./rulesets.mjs";
import { appsFor, tokensFor } from "./spec.mjs";

export const TOKEN_DURATION = "8760h";

export const tokenSecretNames = (env, role) => {
  const base = `${secretPrefix(env)}ACCESS_${role.toUpperCase()}`;
  return { clientId: `${base}_CLIENT_ID`, clientSecret: `${base}_CLIENT_SECRET` };
};

const splitList = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// The inputs a person must supply: the admin identity provider (M-03) is never guessed.
export function readAccessConfig(envVars, spec, env) {
  const cfg = { teamEmails: splitList(envVars.ACCESS_TEAM_EMAILS), adminEmails: splitList(envVars.ACCESS_ADMIN_EMAILS), idpId: envVars.ACCESS_ADMIN_IDP_ID?.trim() || undefined };
  const missing = [];
  if (cfg.teamEmails.length === 0) missing.push("ACCESS_TEAM_EMAILS (comma-separated emails of the team group)");
  if (appsFor(spec, env).some((a) => a.adminIdpOnly)) {
    if (!cfg.idpId) missing.push("ACCESS_ADMIN_IDP_ID (the id of the hardware-key identity provider from manual task M-03, #101)");
    if (cfg.adminEmails.length === 0) missing.push("ACCESS_ADMIN_EMAILS (comma-separated emails allowed on the admin application)");
  }
  if (missing.length) throw new ConfigError(`missing required Access configuration for --env ${env}:\n  ${missing.join("\n  ")}`);
  return cfg;
}

const emailRule = (email) => ({ email: { email } });

export function desiredApp(app, { teamGroupId, tokenIds, cfg }) {
  const include = (inc) => {
    if (inc.admins) return cfg.adminEmails.map(emailRule);
    if (inc.team) return [{ group: { id: teamGroupId } }];
    if (inc.serviceToken) return [{ service_token: { token_id: tokenIds[inc.serviceToken] } }];
    if (inc.everyone) return [{ everyone: {} }];
    throw new Error(`${app.name}: unrecognised include ${JSON.stringify(inc)}`);
  };
  const body = {
    name: app.name,
    type: "self_hosted",
    destinations: app.destinations.map((uri) => ({ type: "public", uri })),
    session_duration: app.sessionDuration ?? "24h",
    app_launcher_visible: false,
    policies: app.policies.map((p, i) => ({ name: p.name, decision: p.decision, include: p.include.flatMap(include), precedence: i + 1 })),
  };
  if (app.adminIdpOnly) {
    body.allowed_idps = [cfg.idpId];
    body.auto_redirect_to_identity = true;
  }
  return body;
}

const summarise = (a) => ({
  destinations: (a.destinations ?? []).map((d) => d.uri).sort(),
  allowed_idps: [...(a.allowed_idps ?? [])].sort(),
  policies: (a.policies ?? []).map((p) => ({ name: p.name, decision: p.decision, include: p.include })),
  session_duration: a.session_duration,
});
const summariseDesired = (b) => summarise({ ...b, policies: b.policies });

export async function ensureAccess({ api, accountId, env, spec, cfg, secrets, write, out, failures }) {
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
      out(`FAILED ${label}: ${e.message}`);
      return undefined;
    }
  };
  const acct = (method, path, body) => api(method, `/accounts/${accountId}${path}`, body);

  // The identity provider must be seen in a successful listing, and must not be a one-time PIN.
  if (appsFor(spec, env).some((a) => a.adminIdpOnly)) {
    await attempt("admin identity provider", async () => {
      const idps = (await acct("GET", "/access/identity_providers")).result;
      if (!Array.isArray(idps)) throw new Error("unrecognised identity provider listing");
      const idp = idps.find((i) => i.id === cfg.idpId);
      if (!idp) throw new Error(`identity provider ${cfg.idpId} is not in this account's Access identity providers; check ACCESS_ADMIN_IDP_ID against M-03`);
      if (idp.type === "onetimepin") throw new Error(`identity provider ${cfg.idpId} is One-time PIN; the admin application needs the hardware-key provider`);
      out(`ok       identity provider ${idp.name ?? idp.id} (${idp.type})`);
    });
    if (failures.length) return;
  }

  // Service tokens: the secret is readable once, so it goes straight to the Secrets Store.
  const tokenIds = {};
  const tokenList = async () => new Map((await listAll(acct, "/access/service_tokens", (j) => j.result)).map((t) => [t.name, t]));
  for (const t of tokensFor(spec, env)) {
    await attempt(`service token ${t.name}`, async () => {
      const names = tokenSecretNames(env, t.role);
      const have = (await tokenList()).get(t.name);
      if (have) {
        const stored = await secrets.listNames();
        for (const n of Object.values(names)) {
          if (!stored.has(n)) throw new Error(`token ${t.name} exists but ${n} is not in the Secrets Store; rotate the token in the dashboard and store it`);
        }
        out(`ok       service token ${t.name}`);
        tokenIds[t.role] = have.id;
        return;
      }
      if (!write) {
        out(`would    create service token ${t.name} -> Secrets Store ${Object.values(names).join(", ")}`);
        return;
      }
      const made = (await acct("POST", "/access/service_tokens", { name: t.name, duration: TOKEN_DURATION })).result;
      if (!made?.id || !made.client_id || !made.client_secret) throw new Error(`token ${t.name} was created without a usable id and secret; delete it in the dashboard and re-run`);
      tokenIds[t.role] = made.id;
      try {
        await secrets.create(names.clientId, made.client_id, `${t.name} (${env})`);
        await secrets.create(names.clientSecret, made.client_secret, `${t.name} (${env})`);
      } catch (e) {
        try {
          await acct("DELETE", `/access/service_tokens/${made.id}`);
        } catch {
          // The original error is the one to report.
        }
        throw new Error(`could not store ${t.name}: ${e.message}; the token was deleted, re-run`, { cause: e });
      }
      out(`created  service token ${t.name} -> Secrets Store ${Object.values(names).join(", ")}`);
    });
  }

  // Team group
  let teamGroupId;
  await attempt(`group ${spec.access.teamGroup}`, async () => {
    const groups = new Map((await listAll(acct, "/access/groups", (j) => j.result)).map((g) => [g.name, g]));
    const include = cfg.teamEmails.map(emailRule);
    const have = groups.get(spec.access.teamGroup);
    if (have) {
      teamGroupId = have.id;
      if (same(have.include, include)) {
        out(`ok       group ${have.name}`);
      } else if (!write) {
        out(`would    update group ${have.name}`);
      } else {
        await acct("PUT", `/access/groups/${have.id}`, { name: have.name, include });
        out(`updated  group ${have.name}`);
      }
      return;
    }
    if (!write) {
      out(`would    create group ${spec.access.teamGroup}`);
      return;
    }
    const made = (await acct("POST", "/access/groups", { name: spec.access.teamGroup, include })).result;
    if (!made?.id) throw new Error("create answered without a group id");
    teamGroupId = made.id;
    out(`created  group ${spec.access.teamGroup}`);
  });

  // Applications
  const apps = appsFor(spec, env);
  const needs = (app) => app.policies.flatMap((p) => p.include).filter((i) => i.team || i.serviceToken);
  const listApps = async () => new Map((await listAll(acct, "/access/apps", (j) => j.result)).map((a) => [a.name, a]));
  let existing;
  try {
    existing = await listApps();
  } catch (e) {
    failures.push(`access applications: ${e.message}`);
    out(`FAILED access applications: ${e.message}`);
    return;
  }
  for (const app of apps) {
    await attempt(`access application ${app.name}`, async () => {
      const unresolved = needs(app).some((i) => (i.team ? !teamGroupId : !tokenIds[i.serviceToken]));
      const have = existing.get(app.name);
      if (unresolved) {
        if (write) throw new Error("a group or service token it depends on is missing");
        out(`would    ${have ? "update" : "create"} access application ${app.name} (needs a group or token this run would create)`);
        return;
      }
      const body = desiredApp(app, { teamGroupId, tokenIds, cfg });
      if (have && same(summarise(have), summariseDesired(body))) {
        out(`ok       access application ${app.name}`);
        return;
      }
      if (!write) {
        out(`would    ${have ? "update" : "create"} access application ${app.name}`);
        return;
      }
      if (have) {
        await acct("PUT", `/access/apps/${have.id}`, body);
        out(`updated  access application ${app.name}`);
      } else {
        const made = (await acct("POST", "/access/apps", body)).result;
        if (!made?.id) throw new Error("create answered without an application id");
        out(`created  access application ${app.name}`);
      }
    });
  }
}
