// Cloudflare Secrets Store over the REST API. Endpoints and the `scopes` field:
// https://developers.cloudflare.com/secrets-store/manage-secrets/how-to/
// A failed listing throws; only a successful listing without the name means "absent".

const API = "https://api.cloudflare.com/client/v4";
const PER_PAGE = 100;

export const STAGING_PREFIX = "STAGING_";

export function secretPrefix(env) {
  if (env === "production") return "";
  if (env === "staging") return STAGING_PREFIX;
  throw new Error(`--env must be "staging" or "production", got "${env}"`);
}

async function call(fetchImpl, token, method, path, body) {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Cloudflare ${method} ${path}: HTTP ${res.status} with a non-JSON body`);
  }
  if (!res.ok || json.success === false) {
    const detail = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare ${method} ${path}: HTTP ${res.status} ${detail}`.trim());
  }
  return json;
}

export function createSecretsStore({ fetch: fetchImpl, accountId, token, storeId }) {
  const base = `/accounts/${accountId}/secrets_store/stores`;
  let resolved = storeId;

  async function resolveStoreId() {
    if (resolved) return resolved;
    const { result } = await call(fetchImpl, token, "GET", base);
    if (!Array.isArray(result) || result.length === 0) {
      throw new Error("no Secrets Store exists in this account; create one with `wrangler secrets-store store create <name> --remote`");
    }
    if (result.length > 1) {
      throw new Error(`${result.length} Secrets Stores found; pass CLOUDFLARE_SECRETS_STORE_ID to pick one`);
    }
    resolved = result[0].id;
    return resolved;
  }

  async function listNames() {
    const id = await resolveStoreId();
    const names = new Set();
    for (let page = 1; ; page++) {
      const json = await call(fetchImpl, token, "GET", `${base}/${id}/secrets?page=${page}&per_page=${PER_PAGE}`);
      for (const s of json.result ?? []) names.add(s.name);
      const totalPages = json.result_info?.total_pages ?? 1;
      if (page >= totalPages) return names;
    }
  }

  // One POST per call: the endpoint takes an array, and a rejected batch should not hide
  // which secret was refused.
  async function create(name, value, comment = "") {
    const id = await resolveStoreId();
    await call(fetchImpl, token, "POST", `${base}/${id}/secrets`, [{ name, value, scopes: ["workers"], comment }]);
  }

  return { resolveStoreId, listNames, create };
}

export function cloudflareConfigFromEnv(env) {
  const missing = ["CF_BOOTSTRAP_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing required environment: ${missing.join(", ")}`);
  return {
    token: env.CF_BOOTSTRAP_TOKEN,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    storeId: env.CLOUDFLARE_SECRETS_STORE_ID || undefined,
  };
}
