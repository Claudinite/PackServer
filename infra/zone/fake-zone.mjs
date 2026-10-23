// An in-memory stand-in for the Cloudflare endpoints infra/zone uses, layered on the T-010 fake
// (zones, accounts, Secrets Store). Shapes follow the endpoints named in each handler. Test support only.
import { fakeCloudflare } from "../fake-cloudflare.mjs";
import { evaluateNetwork, parseNetworkCase } from "./lib/transformer.mjs";

// What Logpush would have delivered for the transformer jobs, dated far enough ahead to count as fresh.
export function deliveredObjects(overrides = {}) {
  const record = (extra = {}) => JSON.stringify({ CacheCacheStatus: "hit", ClientRequestPath: "/x", EdgeStartTimestamp: "2026-10-23T00:00:00Z", ClientNetwork: "198.51.100.0/24", ...extra });
  const out = [];
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  for (const bucket of ["ops", "ops-staging"]) {
    out.push({ bucket, key: `logs/http-requests/hits/${day}/a.log`, last_modified: "2999-01-01T00:00:00Z", body: `${record()}\n${record()}\n`, ...overrides.hits });
    out.push({ bucket, key: `logs/http-requests/misses/${day}/a.log`, last_modified: "2999-01-01T00:00:00Z", body: `${record({ CacheCacheStatus: "miss" })}\n`, ...overrides.misses });
  }
  return out;
}

export function fakeZone({ seed = {}, failGet = [], failWrite = [], failSecretNumber, idps, base, transformersForbidden = false, previewLeaksIp = false, delivered = true } = {}) {
  const inner = base ?? fakeCloudflare({ seed: { stores: [{ id: "store1", name: "packserver" }], ...(seed.base ?? {}) } });
  const state = {
    rulesets: structuredClone(seed.rulesets ?? {}),
    tiered: seed.tiered ?? "off",
    tokens: structuredClone(seed.tokens ?? []),
    groups: structuredClone(seed.groups ?? []),
    apps: structuredClone(seed.apps ?? []),
    idps: idps ?? [{ id: "idp-hw", name: "Hardware key", type: "saml" }],
    jobs: structuredClone(seed.jobs ?? []),
    transformers: structuredClone(seed.transformers ?? []),
    listedPrefixes: [],
    objects: structuredClone(seed.objects ?? (delivered ? deliveredObjects() : [])),
    lifecycle: structuredClone(seed.lifecycle ?? {}),
    inner: inner.state,
  };
  const calls = [];
  let secretPosts = 0;
  let n = 0;
  const id = (p) => `${p}-${String(++n).padStart(4, "0")}`;
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const ok = (result, info) => json(200, { success: true, result, ...(info ? { result_info: info } : {}) });
  const fail = (status, code, message) => json(status, { success: false, errors: [{ code, message }] });
  const page = (list, url, maxPerPage = 1000) => {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 20), maxPerPage);
    const p = Number(url.searchParams.get("page") ?? 1);
    return ok(list.slice((p - 1) * per, p * per), { page: p, per_page: per, count: Math.min(per, Math.max(0, list.length - (p - 1) * per)), total_count: list.length });
  };
  const ruleView = (r) => ({ ...r, id: r.id ?? id("rule"), version: "1", last_updated: "2026-10-23T00:00:00Z" });

  const fetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    const method = init.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    let sm;
    if ((sm = path.match(/^\/accounts\/acct\/secrets_store\/stores\/[^/]+\/secrets(?:\/([^/]+))?$/))) {
      // The T-010 fake lists names only; here a secret's id is its name, so it can be deleted.
      if (method === "POST" && ++secretPosts >= failSecretNumber) return fail(403, 2, "refused");
      if (method === "GET") {
        const res = await inner.fetch(rawUrl, init);
        const j = await res.json();
        return ok(j.result.map((x) => ({ ...x, id: x.name })), j.result_info);
      }
      if (method === "DELETE") {
        inner.state.secrets = inner.state.secrets.filter((x) => x !== sm[1]);
        delete (inner.state.secretValues ?? {})[sm[1]];
        return ok({ id: sm[1] });
      }
    }
    const mine = /^\/(zones\/zone1\/(rulesets|cache|logpush)|accounts\/acct\/(access|logpush|r2\/buckets\/[^/]+\/(lifecycle|objects)))/.test(path);
    if (!mine) return inner.fetch(rawUrl, init);
    calls.push({ method, path, body });
    if (method === "GET" && failGet.some((f) => path.includes(f))) return fail(500, 1, "boom");
    if (method !== "GET" && failWrite.some((f) => path.includes(f))) return fail(500, 2, "refused");
    let r;
    if ((r = path.match(/^\/zones\/zone1\/rulesets\/phases\/([^/]+)\/entrypoint$/))) {
      const rs = state.rulesets[r[1]];
      return rs ? ok(rs) : fail(404, 10003, "could not find entrypoint ruleset");
    }
    if (path === "/zones/zone1/rulesets" && method === "POST") {
      const made = { id: id("rs"), phase: body.phase, kind: body.kind, rules: body.rules.map(ruleView) };
      state.rulesets[body.phase] = made;
      return ok(made);
    }
    if ((r = path.match(/^\/zones\/zone1\/rulesets\/([^/]+)$/)) && method === "PUT") {
      const rs = Object.values(state.rulesets).find((x) => x.id === r[1]);
      if (!rs) return fail(404, 1, "no such ruleset");
      rs.rules = body.rules.map(ruleView);
      return ok(rs);
    }
    if (path === "/zones/zone1/cache/tiered_cache_smart_topology_enable") {
      if (method === "PATCH") state.tiered = body.value;
      return ok({ id: "tiered_cache_smart_topology_enable", value: state.tiered });
    }
    if (path === "/accounts/acct/access/identity_providers") return ok(state.idps);
    const collection = { "/accounts/acct/access/service_tokens": ["tokens", "tok"], "/accounts/acct/access/groups": ["groups", "grp"], "/accounts/acct/access/apps": ["apps", "app"] }[path];
    if (collection) {
      const [key, prefix] = collection;
      if (method === "GET") return page(state[key], url, 100);
      const made = { id: id(prefix), ...body };
      if (key === "tokens") Object.assign(made, { client_id: `${made.id}.access`, client_secret: `secret-of-${made.id}` });
      state[key].push(key === "tokens" ? { id: made.id, name: made.name } : made);
      return ok(made);
    }
    if ((r = path.match(/^\/accounts\/acct\/access\/(groups|apps|service_tokens)\/([^/]+)$/))) {
      const key = r[1] === "service_tokens" ? "tokens" : r[1];
      const i = state[key].findIndex((x) => x.id === r[2]);
      if (i < 0) return fail(404, 1, "not found");
      if (method === "PUT") state[key][i] = { id: r[2], ...body };
      if (method === "DELETE") state[key].splice(i, 1);
      return ok({ id: r[2] });
    }
    if ((r = path.match(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/objects(?:\/(.+))?$/))) {
      const mine = state.objects.filter((o) => o.bucket === r[1]);
      if (!r[2]) {
        const prefix = url.searchParams.get("prefix") ?? "";
        state.listedPrefixes.push(prefix);
        return ok(mine.filter((o) => o.key.startsWith(prefix)).map(({ key, last_modified }) => ({ key, last_modified, size: 1 })), { is_truncated: false });
      }
      const obj = mine.find((o) => o.key === decodeURIComponent(r[2]));
      if (!obj) return fail(404, 10007, "no such object");
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(obj.body) };
    }
    if (path.startsWith("/accounts/acct/logpush/transformers")) {
      if (transformersForbidden) return fail(403, 1000, "transformer feature is not available for this account");
      const view = (t) => ({ id: t.id, name: t.name, dataset: "http_requests", ...(t.updated_at ? { updated_at: t.updated_at } : {}) });
      if (path === "/accounts/acct/logpush/transformers") {
        if (method === "GET") return ok(state.transformers.map(view));
        const made = { id: state.transformers.length + 1, name: body.name, code: body.code };
        state.transformers.push(made);
        return ok(view(made));
      }
      if (path === "/accounts/acct/logpush/transformers/preview") {
        // Evaluates the CASE the SQL carries; the WHERE is read from the SQL text.
        const { sql, input } = body;
        const hosts = [...(sql.match(/ClientRequestHost IN \(([^)]*)\)/)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
        const hit = input.CacheCacheStatus === "hit";
        const keeps = hosts.includes(input.ClientRequestHost) && (sql.includes("CacheCacheStatus = 'hit'") ? hit : !hit);
        if (!keeps) return ok([]);
        const { ClientIP, ...rest } = input;
        return ok([{ ...rest, ...(previewLeaksIp ? { ClientIP } : {}), ClientNetwork: evaluateNetwork(parseNetworkCase(sql), ClientIP) }]);
      }
      const r2 = path.match(/^\/accounts\/acct\/logpush\/transformers\/(\d+)(\/content)?$/);
      const t = r2 && state.transformers.find((x) => String(x.id) === r2[1]);
      if (!t) return fail(400, 1001, "transformer not found for this account");
      if (r2[2]) return ok({ content: t.code });
      if (method === "PUT") t.code = body.code ?? t.code;
      return ok(view(t));
    }
    if (path === "/zones/zone1/logpush/jobs") {
      if (method === "GET") return ok(state.jobs.map((j) => ({ ...j, destination_conf: j.destination_conf.split("&access-key-id=")[0] })));
      if (body.transformer_id && body.filter) return fail(400, 1002, "a job cannot have both a filter and a transformer configured; use one or the other");
      const made = { id: state.jobs.length + 1, ...body };
      state.jobs.push(made);
      return ok(made);
    }
    if ((r = path.match(/^\/zones\/zone1\/logpush\/jobs\/(\d+)$/)) && method === "PUT") {
      if (body.transformer_id && body.filter) return fail(400, 1002, "a job cannot have both a filter and a transformer configured; use one or the other");
      const i = state.jobs.findIndex((j) => String(j.id) === r[1]);
      state.jobs[i] = { id: Number(r[1]), ...body };
      return ok(state.jobs[i]);
    }
    if ((r = path.match(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/lifecycle$/))) {
      if (method === "PUT") state.lifecycle[r[1]] = { rules: body.rules };
      return ok(state.lifecycle[r[1]] ?? { rules: [] });
    }
    return fail(404, 404, `fake has no ${method} ${path}`);
  };
  const writes = () => [...calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/transformers/preview")), ...inner.creates()];
  return { fetch, state, calls, inner, writes };
}
