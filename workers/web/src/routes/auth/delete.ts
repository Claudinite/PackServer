import { checkDeletable, deleteAccount } from "@packserver/core/identity";
import { clearedSessionCookie, refusal } from "@packserver/http";
import { Hono } from "hono";
import { recordAudit, sessionPorts, type WebEnv } from "../../context";
import { sensitive } from "../scopes/guard";
import { NO_STORE } from "./ceremony";

export const routes = new Hono<WebEnv>();

/** Deletes the caller's account. The assertion is made for the account itself, so it works on no other. */
routes.post("/auth/delete", sensitive("account.delete", (c) => c.get("session")!.record.user_id), async (c) => {
  const runtime = c.get("runtime");
  const userId = c.get("session")!.record.user_id;
  const result = await checkDeletable(runtime.ports.d1, userId);
  if (!result.ok) {
    return refusal("forbidden", {
      status: 409,
      message: `You are the only owner of ${result.orgs.map((o) => `@${o}`).join(", ")}. Add another owner or delete the organisation first.`,
    });
  }
  await recordAudit(c, userId, "account.deleted");
  await deleteAccount({ ...sessionPorts(runtime), clock: runtime.ports.clock }, userId);
  return c.json({ deleted: true }, 200, { ...NO_STORE, "set-cookie": clearedSessionCookie });
});
