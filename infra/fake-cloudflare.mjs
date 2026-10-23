// An in-memory stand-in for the Cloudflare REST endpoints infra/provision.mjs uses, shaped from
// the responses of the endpoints named in each handler. Test support only.
export function fakeCloudflare({ failGet = [], seed = {}, failPost = [], r2DevEnabled = true, pageSize } = {}) {
  const state = {
    d1: [...(seed.d1 ?? [])],
    kv: [...(seed.kv ?? [])],
    r2: [...(seed.r2 ?? [])],
    vectorize: [...(seed.vectorize ?? [])],
    queues: [...(seed.queues ?? [])],
    widgets: [...(seed.widgets ?? [])],
    stores: [...(seed.stores ?? [])],
    secrets: [...(seed.secrets ?? [])],
    dns: [...(seed.dns ?? [])],
    tokens: [...(seed.tokens ?? [])],
    domains: { ...(seed.domains ?? {}) },
    managed: {},
  };
  const calls = [];
  let n = 0;
  const id = (p) => `${p}-${String(++n).padStart(4, "0")}`;
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const ok = (result, info) => json(200, { success: true, result, ...(info ? { result_info: info } : {}) });
  // result_info as the real endpoints send it: total_pages only where Cloudflare documents it
  // (Queues, Secrets Store, DNS); the rest carry count and total_count; tokens cap per_page at 50.
  const page = (list, url, { totalPages = false, maxPerPage = 1000 } = {}) => {
    const per = Math.min(pageSize ?? Number(url.searchParams.get("per_page") ?? 20), maxPerPage);
    const p = Number(url.searchParams.get("page") ?? 1);
    const items = list.slice((p - 1) * per, p * per);
    const info = { page: p, per_page: per, count: items.length, total_count: list.length };
    if (totalPages) info.total_pages = Math.max(1, Math.ceil(list.length / per));
    return ok(items, info);
  };

  const fetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    const method = init.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, query: url.search });
    if (method === "GET" && failGet.some((f) => (typeof f === "string" ? path.includes(f) : f.test(path)))) {
      return json(failGet.status ?? 500, { success: false, errors: [{ code: 1, message: "boom" }] });
    }
    if (method === "POST" && failPost.some((f) => path.includes(f))) return json(500, { success: false, errors: [{ code: 2, message: "refused" }] });
    const m = (re) => path.match(re);
    let r;
    if (path === "/accounts") return ok([{ id: "acct" }]);
    if (path === "/zones") return ok([{ id: "zone1", name: url.searchParams.get("name") }]);
    if ((r = m(/^\/accounts\/acct\/secrets_store\/stores$/))) {
      if (method === "GET") return page(state.stores, url, { totalPages: true });
      if (Array.isArray(body) || typeof body?.name !== "string") return json(400, { success: false, errors: [{ code: 400, message: "body must be an object with name" }] });
      if (state.stores.length >= 1) return json(409, { success: false, errors: [{ code: 409, message: "one store per account" }] });
      const made = { id: id("store"), name: body.name };
      state.stores.push(made);
      return ok(made);
    }
    if ((r = m(/^\/accounts\/acct\/secrets_store\/stores\/([^/]+)\/secrets$/))) {
      if (method === "GET") return page(state.secrets.map((name) => ({ name })), url, { totalPages: true });
      for (const s of body) {
        if (state.secrets.includes(s.name)) return json(409, { success: false, errors: [{ code: 3, message: "duplicate" }] });
        state.secrets.push(s.name);
        (state.secretValues ??= {})[s.name] = s.value;
      }
      return ok([]);
    }
    if (path === "/accounts/acct/d1/database") {
      if (method === "GET") return page(state.d1, url);
      const made = { uuid: id("d1"), name: body.name, hint: body.primary_location_hint };
      state.d1.push(made);
      return ok(made);
    }
    if (path === "/accounts/acct/storage/kv/namespaces") {
      if (method === "GET") return page(state.kv, url);
      const made = { id: id("kv"), title: body.title };
      state.kv.push(made);
      return ok(made);
    }
    if (path === "/accounts/acct/r2/buckets") {
      if (method === "GET") return ok({ buckets: state.r2.map((name) => ({ name })) }, {});
      state.r2.push(body.name);
      state.managed[body.name] = r2DevEnabled;
      return ok({ name: body.name });
    }
    if ((r = m(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/domains\/managed$/))) {
      if (method === "PUT") state.managed[r[1]] = body.enabled;
      return ok({ bucketId: r[1], enabled: state.managed[r[1]] ?? r2DevEnabled });
    }
    if ((r = m(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/domains\/custom$/))) {
      if (method === "GET") return ok({ domains: (state.domains[r[1]] ??= []).map((domain) => ({ domain })) });
      (state.domains[r[1]] ??= []).push(body.domain);
      return ok({ domain: body.domain });
    }
    if (path === "/accounts/acct/vectorize/v2/indexes") {
      if (method === "GET") return ok(state.vectorize);
      const made = { name: body.name, config: { dimensions: body.config.dimensions } };
      state.vectorize.push(made);
      return ok(made);
    }
    if (path === "/accounts/acct/queues") {
      if (method === "GET") return page(state.queues, url, { totalPages: true });
      const made = { queue_id: id("queue"), queue_name: body.queue_name };
      state.queues.push(made);
      return ok(made);
    }
    if (path === "/accounts/acct/challenges/widgets") {
      if (method === "GET") return page(state.widgets, url);
      const made = { sitekey: id("site"), name: body.name, secret: "turnstile-secret-value" };
      state.widgets.push({ sitekey: made.sitekey, name: made.name });
      return ok(made);
    }
    if ((r = m(/^\/zones\/zone1\/dns_records$/))) {
      if (method === "GET") {
        const name = url.searchParams.get("name");
        return page(state.dns.filter((d) => d.name === name), url, { totalPages: true });
      }
      const made = { id: id("dns"), name: body.name, proxied: body.proxied, type: body.type };
      state.dns.push(made);
      return ok(made);
    }
    if (path === "/accounts/acct/tokens/permission_groups") {
      // Not paginated: every group comes back, with no page counts.
      const groups = [
        ...Array.from({ length: 300 }, (_, i) => ({ id: `pg-filler-${i}`, name: `Filler Permission ${i}` })),
        { id: "pg-read", name: "Workers R2 Storage Bucket Item Read" },
        { id: "pg-write", name: "Workers R2 Storage Bucket Item Write" },
        { id: "pg-admin", name: "Workers R2 Storage Write" },
      ];
      const want = url.searchParams.get("name");
      return ok(want ? groups.filter((g) => g.name === want) : groups);
    }
    if (path === "/accounts/acct/tokens") {
      if (method === "GET") return page(state.tokens, url, { maxPerPage: 50 });
      const made = { id: id("tok"), name: body.name, value: `value-of-${body.name}`, policies: body.policies };
      state.tokens.push({ id: made.id, name: made.name, policies: made.policies });
      return ok(made);
    }
    if ((r = m(/^\/accounts\/acct\/tokens\/([^/]+)$/)) && method === "DELETE") {
      state.tokens = state.tokens.filter((t) => t.id !== r[1]);
      return ok({ id: r[1] });
    }
    return json(404, { success: false, errors: [{ code: 404, message: `fake has no ${method} ${path}` }] });
  };
  return { fetch, state, calls, creates: () => calls.filter((c) => c.method !== "GET") };
}
