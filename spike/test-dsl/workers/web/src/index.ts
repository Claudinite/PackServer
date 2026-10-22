// "web" Worker: sign-in through an external OIDC issuer, publish packs (D1 row +
// R2 archive + external validation call), view packs, and proxy search to the
// "mcp" Worker over a service binding.
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { record } from "../../shared-record";

export interface Env {
  DB: D1Database;
  ARCHIVES: R2Bucket;
  MCP: Fetcher;
  OIDC_ISSUER: string;
  OIDC_AUDIENCE: string;
  LLM_URL: string;
}

type PackRow = {
  id: number;
  name: string;
  owner_id: number;
  summary: string;
  visibility: "public" | "private";
  validation: string | null;
  r2_key: string;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function currentUser(req: Request, env: Env): Promise<{ id: number; email: string } | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
  )
    .bind(token)
    .first<{ id: number; email: string }>();
  record({ kind: "d1", target: "sessions", op: "lookup", request: { token }, result: row, effect: "read" });
  return row ?? null;
}

async function signIn(req: Request, env: Env): Promise<Response> {
  const { idToken } = (await req.json()) as { idToken?: string };
  if (!idToken) return json({ error: "idToken required" }, 400);

  // External dependency #1: the issuer's JWKS.
  const jwksUrl = `${env.OIDC_ISSUER.replace(/\/$/, "")}/.well-known/jwks`;
  let jwks: JSONWebKeySet;
  try {
    const jwksRes = await fetch(jwksUrl);
    if (!jwksRes.ok) throw new Error(`issuer answered ${jwksRes.status}: ${await jwksRes.text()}`);
    jwks = (await jwksRes.json()) as JSONWebKeySet;
  } catch (e) {
    return json({ error: "issuer unreachable", detail: String(e) }, 502);
  }
  record({ kind: "http", target: new URL(jwksUrl).host, op: "signing-keys", result: { keys: jwks.keys.length } });

  let email: string;
  try {
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_AUDIENCE,
    });
    email = String(payload.email ?? payload.sub);
  } catch (e) {
    return json({ error: "invalid token", detail: String(e) }, 401);
  }

  await env.DB.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)").bind(email).run();
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: number }>();
  const token = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").bind(token, user!.id).run();
  record({ kind: "d1", target: "sessions", op: "insert", request: { email }, effect: "write" });
  return json({ token, email });
}

async function publish(req: Request, env: Env): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) return json({ error: "sign in first" }, 401);
  const body = (await req.json()) as { name: string; summary?: string; visibility?: "public" | "private"; archive: string };
  if (!body.name || typeof body.archive !== "string") return json({ error: "name and archive required" }, 400);

  const r2Key = `archives/${body.name}.tar`;
  const ins = await env.DB.prepare(
    "INSERT INTO packs (name, owner_id, summary, visibility, r2_key) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(body.name, user.id, body.summary ?? "", body.visibility ?? "public", r2Key)
    .run();
  record({ kind: "d1", target: "packs", op: "insert", request: { name: body.name, visibility: body.visibility ?? "public" }, result: { changes: ins.meta.changes }, effect: "write" });

  await env.ARCHIVES.put(r2Key, body.archive);
  record({ kind: "r2", target: "ARCHIVES", op: "put", request: { key: r2Key, bytes: body.archive.length }, effect: "write" });

  // External dependency #2: the validation LLM.
  let verdict: { verdict: string };
  try {
    const llmRes = await fetch(env.LLM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: body.name, archive: body.archive }),
    });
    if (!llmRes.ok) throw new Error(`validator answered ${llmRes.status}`);
    verdict = (await llmRes.json()) as { verdict: string };
  } catch (e) {
    return json({ error: "validator unreachable", detail: String(e) }, 502);
  }
  record({ kind: "http", target: new URL(env.LLM_URL).host, op: "validate", request: { name: body.name }, result: verdict });

  await env.DB.prepare("UPDATE packs SET validation = ? WHERE name = ?").bind(verdict.verdict, body.name).run();
  record({ kind: "d1", target: "packs", op: "update", request: { name: body.name, validation: verdict.verdict }, effect: "write" });

  return json({ name: body.name, visibility: body.visibility ?? "public", validation: verdict.verdict }, 201);
}

async function view(req: Request, env: Env, name: string): Promise<Response> {
  const user = await currentUser(req, env);
  const row = await env.DB.prepare("SELECT * FROM packs WHERE name = ?").bind(name).first<PackRow>();
  record({ kind: "d1", target: "packs", op: "select", request: { name }, result: row ? { found: true, visibility: row.visibility } : { found: false }, effect: "read" });
  // A private pack is indistinguishable from a missing one for outsiders.
  if (!row || (row.visibility === "private" && row.owner_id !== user?.id)) return json({ error: "not found" }, 404);
  return json({ name: row.name, summary: row.summary, visibility: row.visibility, validation: row.validation });
}

async function archive(req: Request, env: Env, name: string): Promise<Response> {
  const user = await currentUser(req, env);
  const row = await env.DB.prepare("SELECT * FROM packs WHERE name = ?").bind(name).first<PackRow>();
  if (!row || (row.visibility === "private" && row.owner_id !== user?.id)) return json({ error: "not found" }, 404);
  const obj = await env.ARCHIVES.get(row.r2_key);
  record({ kind: "r2", target: "ARCHIVES", op: "get", request: { key: row.r2_key }, result: { found: obj !== null }, effect: "read" });
  if (!obj) return json({ error: "archive missing" }, 500);
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/health") return json({ ok: true, worker: "web" });
    if (req.method === "POST" && p === "/auth/signin") return signIn(req, env);
    if (req.method === "POST" && p === "/packs") return publish(req, env);
    const m = p.match(/^\/packs\/([^/]+)(\/archive)?$/);
    if (req.method === "GET" && m) return m[2] ? archive(req, env, decodeURIComponent(m[1])) : view(req, env, decodeURIComponent(m[1]));
    if (req.method === "GET" && p === "/search") {
      // The site's search box goes through the mcp Worker over a service binding.
      const res = await env.MCP.fetch(`http://mcp/search?q=${encodeURIComponent(url.searchParams.get("q") ?? "")}`);
      record({ kind: "service", target: "MCP", op: "GET /search", result: { status: res.status } });
      return new Response(res.body, res);
    }
    return json({ error: "no route" }, 404);
  },
} satisfies ExportedHandler<Env>;
