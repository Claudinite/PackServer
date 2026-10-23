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

// A problem with the invocation (missing or ambiguous input); scripts exit 2 for it.
export class ConfigError extends Error {}

// Errors worth retrying: the request never got an answer, or the server failed.
export const isRetryable = (e) => e?.retryable === true;

export async function call(fetchImpl, token, method, path, body) {
  let res;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw Object.assign(new Error(`Cloudflare ${method} ${path}: network error (${cause?.message ?? cause})`), { retryable: true, cause });
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw Object.assign(new Error(`Cloudflare ${method} ${path}: HTTP ${res.status} with a non-JSON body`), { retryable: res.status >= 500 });
  }
  if (!res.ok || json.success === false) {
    const detail = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw Object.assign(new Error(`Cloudflare ${method} ${path}: HTTP ${res.status} ${detail}`.trim()), { retryable: res.status >= 500 });
  }
  return json;
}

export function createSecretsStore({ fetch: fetchImpl, accountId, token, storeId, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelaysMs = [1000, 3000, 9000] }) {
  const base = `/accounts/${accountId}/secrets_store/stores`;
  let resolved = storeId;

  async function resolveStoreId() {
    if (resolved) return resolved;
    const { result } = await call(fetchImpl, token, "GET", base);
    if (!Array.isArray(result) || result.length === 0) {
      throw new Error("no Secrets Store exists in this account; create one with `wrangler secrets-store store create <name> --remote`");
    }
    if (result.length > 1) {
      throw new ConfigError(`${result.length} Secrets Stores found; set CLOUDFLARE_SECRETS_STORE_ID to pick one`);
    }
    resolved = result[0].id;
    return resolved;
  }

  async function listSecrets() {
    const id = await resolveStoreId();
    const byName = new Map();
    for (let page = 1; ; page++) {
      const json = await call(fetchImpl, token, "GET", `${base}/${id}/secrets?page=${page}&per_page=${PER_PAGE}`);
      for (const s of json.result ?? []) byName.set(s.name, s.id);
      const totalPages = json.result_info?.total_pages ?? 1;
      if (page >= totalPages) return byName;
    }
  }

  const listNames = async () => new Set((await listSecrets()).keys());

  // One POST per call: the endpoint takes an array, and a rejected batch should not hide
  // which secret was refused.
  async function createOnce(name, value, comment) {
    const id = await resolveStoreId();
    await call(fetchImpl, token, "POST", `${base}/${id}/secrets`, [{ name, value, scopes: ["workers"], comment }]);
  }

  async function create(name, value, comment = "") {
    for (let attempt = 0; ; attempt++) {
      try {
        return await createOnce(name, value, comment);
      } catch (e) {
        if (!isRetryable(e) || attempt >= retryDelaysMs.length) throw e;
        await sleep(retryDelaysMs[attempt]);
        // The failed attempt may have been applied with its reply lost; a retry would then
        // be refused as a duplicate and reported as a failure.
        if ((await listNames()).has(name)) return;
      }
    }
  }

  async function remove(name) {
    const id = await resolveStoreId();
    const secretId = (await listSecrets()).get(name);
    if (!secretId) throw new Error(`cannot delete ${name}: not found in the store`);
    await call(fetchImpl, token, "DELETE", `${base}/${id}/secrets/${secretId}`);
  }

  // Creating needs the token's Secrets Store Edit permission, which reading does not prove.
  async function probeWrite(name) {
    await createOnce(name, "probe", "write probe; safe to delete");
    try {
      await remove(name);
    } catch (e) {
      throw new Error(`write probe ${name} was created but not deleted (${e.message}); delete it by hand`, { cause: e });
    }
  }

  return { resolveStoreId, listNames, create, remove, probeWrite };
}

export async function resolveCloudflareConfig(env, fetchImpl) {
  if (!env.CF_BOOTSTRAP_TOKEN) throw new ConfigError("missing required environment: CF_BOOTSTRAP_TOKEN");
  const token = env.CF_BOOTSTRAP_TOKEN;
  let accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const { result } = await call(fetchImpl, token, "GET", "/accounts");
    if (!Array.isArray(result) || result.length !== 1) {
      throw new ConfigError(`CLOUDFLARE_ACCOUNT_ID is not set and the token sees ${Array.isArray(result) ? result.length : 0} accounts; set CLOUDFLARE_ACCOUNT_ID`);
    }
    accountId = result[0].id;
  }
  return { token, accountId, storeId: env.CLOUDFLARE_SECRETS_STORE_ID || undefined };
}
