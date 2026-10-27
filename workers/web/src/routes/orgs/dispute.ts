import { recordHolderConsent } from "@packserver/core/scopes";
import { refusal } from "@packserver/http";
import { Hono, type Context } from "hono";
import type { WebEnv } from "../../context";
import { ok, sensitive, standing } from "../scopes/guard";
import { proofPorts } from "./proof-ports";

export const routes = new Hono<WebEnv>();

const orgOf = (c: Context<WebEnv>): string => c.req.param("org") ?? "";

/**
 * The holder of a disputed name agrees to be renamed (REQ-SCOPE-011). A scope with promoted public versions moves
 * only with this; the admin's decision is a separate step, so consenting moves nothing.
 */
routes.post("/orgs/:org/dispute/consent", sensitive("org.consent-reassign", orgOf), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "owner", resource: "public" });
  if (who instanceof Response) return who;
  const result = await recordHolderConsent(proofPorts(c), who.scope.id, c.get("session")!.record.user_id);
  if (result.ok) return ok(c, { consented: true, disputes: result.disputes });
  return refusal("forbidden", { status: 409, message: "There is no dispute on this name." });
});
