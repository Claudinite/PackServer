import { revokeSession } from "@packserver/core/identity";
import { userActivity } from "@packserver/core/audit";
import { clearedSessionCookie, refusal, requireSession } from "@packserver/http";
import { Hono } from "hono";
import { recordAudit, sessionPorts, type WebEnv } from "../../context";
import { signedInPost } from "../scopes/guard";
import { NO_STORE } from "./ceremony";

export const routes = new Hono<WebEnv>();

const HISTORY_LIMIT = 200;

/** Ends one of the caller's sessions. Revoking the one in use is signing out. */
routes.post("/auth/sessions/:id/revoke", signedInPost(), async (c) => {
  const live = c.get("session")!;
  const id = c.req.param("id");
  if (!(await revokeSession(sessionPorts(c.get("runtime")), live.record.user_id, id))) {
    return refusal("forbidden", { status: 404, message: "No such session." });
  }
  await recordAudit(c, live.record.user_id, "session.revoked", id);
  return c.json({ revoked: id }, 200, { ...NO_STORE, ...(id === live.sid_hash ? { "set-cookie": clearedSessionCookie } : {}) });
});

/** The caller's own logins, factor changes and tokens, as far back as the activity copy keeps them: 90 days (REQ-AUDIT-002). */
routes.get("/auth/history", requireSession(), async (c) => {
  const rows = await userActivity(c.get("runtime").ports.d1, c.get("session")!.record.user_id, HISTORY_LIMIT);
  return c.json({ events: rows.map((r) => ({ id: r.id, at: r.at, action: r.action, target: r.target })) }, 200, NO_STORE);
});
