import { chooseHandle, destroySession, listSessions } from "@packserver/core/identity";
import {
  clearedSessionCookie, csrfTokenFor, formFields, idempotency, refusal, requireSession, sessionCaller, sessionCsrf,
} from "@packserver/http";
import { Hono } from "hono";
import { sessionPorts, siteOriginOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

/** Who is signed in, with the token the page's forms must carry. */
routes.get("/auth/session", requireSession(), async (c) => {
  const live = c.get("session")!;
  const { d1 } = c.get("runtime").ports;
  const [user, identities] = await d1.batch([
    { sql: "select id, handle, display_name from users where id = ?", params: [live.record.user_id] },
    { sql: "select provider, login from identities where user_id = ? order by created_at", params: [live.record.user_id] },
  ]);
  const row = user!.rows[0];
  if (!row) return refusal("signed-out");
  return c.json(
    {
      user: { id: row.id, handle: row.handle ?? null, display_name: row.display_name ?? null },
      identities: identities!.rows,
      session: { id: live.sid_hash, device: live.record.device, expires_at: live.record.expires_at },
      csrf: await csrfTokenFor(live),
    },
    200,
    { "cache-control": "no-store" },
  );
});

/** The caller's live sessions. Revoking one is the session-management task's. */
routes.get("/auth/sessions", requireSession(), async (c) => {
  const live = c.get("session")!;
  const sessions = await listSessions(sessionPorts(c.get("runtime")), live.record.user_id, live.sid_hash);
  return c.json({ sessions }, 200, { "cache-control": "no-store" });
});

routes.post(
  "/auth/signout",
  requireSession(),
  sessionCsrf<WebEnv>(siteOriginOf),
  (c, next) => idempotency({ kv: c.get("runtime").ports.kv.SESSIONS_KV!, caller: sessionCaller })(c, next),
  async (c) => {
    await destroySession(sessionPorts(c.get("runtime")), c.get("session")!);
    return c.json({ signed_out: true }, 200, { "set-cookie": clearedSessionCookie, "cache-control": "no-store" });
  },
);

/** First login: the account picks its handle once. */
routes.post(
  "/auth/handle",
  requireSession(),
  sessionCsrf<WebEnv>(siteOriginOf),
  (c, next) => idempotency({ kv: c.get("runtime").ports.kv.SESSIONS_KV!, caller: sessionCaller })(c, next),
  async (c) => {
    const fields = await formFields(c);
    const raw = typeof fields.handle === "string" ? fields.handle : ((await c.req.json().catch(() => ({}))) as { handle?: unknown }).handle;
    if (typeof raw !== "string") return refusal("forbidden", { status: 400, message: "format: a handle is required." });
    const { d1, clock, rng } = c.get("runtime").ports;
    const verdict = await chooseHandle({ d1, clock, rng }, c.get("session")!.record.user_id, raw);
    if (verdict.ok) return c.json({ handle: verdict.handle }, 200, { "cache-control": "no-store" });
    const message = `${verdict.reason}: ${verdict.message}`;
    return verdict.reason === "taken" ? refusal("exists", { message }) : refusal("forbidden", { status: verdict.reason === "format" ? 422 : 403, message });
  },
);
