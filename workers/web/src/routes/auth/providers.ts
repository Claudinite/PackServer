import { safeReturnTarget } from "@packserver/core/identity";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { sensitive } from "../scopes/guard";
import { NO_STORE } from "./ceremony";
import { beginGitHub } from "./github";

export const routes = new Hono<WebEnv>();

/**
 * Links GitHub to the signed-in account. The assertion is spent here, at the start; the callback
 * then adds the identity only for a browser still signed in as the same person.
 */
routes.post("/auth/providers/github/link", sensitive("provider.link", () => "github"), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { next?: unknown };
  const next = safeReturnTarget(typeof body.next === "string" ? body.next : "/account/security");
  const { location, cookie } = await beginGitHub(c, { next, link: { user_id: c.get("session")!.record.user_id } });
  return c.json({ redirect: location }, 200, { ...NO_STORE, "set-cookie": cookie });
});
