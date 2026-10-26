import { applicationOf, applyForVerified, pendingApplicationsFor } from "@packserver/core/scopes";
import { refusal, requireSession } from "@packserver/http";
import { Hono, type Context } from "hono";
import type { WebEnv } from "../../context";
import { notFound, ok, sensitive, standing } from "../scopes/guard";
import { proofPorts } from "./proof-ports";

export const routes = new Hono<WebEnv>();

const orgOf = (c: Context<WebEnv>): string => c.req.param("org") ?? "";

/** The application's state for the organisation's people: pending, denied with its reason, or approved. */
routes.get("/orgs/:org/application", requireSession(), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "maintainer", resource: "public" });
  if (who instanceof Response) return who;
  if (who.scope.kind !== "org") return notFound();
  return ok(c, { org: who.scope.name, application: await applicationOf(c.get("runtime").ports.d1, who.scope.id) });
});

/** Waits for an admin's review. Nothing here asks for payment: Verified Publisher is free through 2026 (REQ-PAY-018). */
routes.post("/orgs/:org/application", sensitive("org.apply-verified", orgOf), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "owner", resource: "public" });
  if (who instanceof Response) return who;
  const result = await applyForVerified(proofPorts(c), who.scope, c.get("session")!.record.user_id);
  if (result.ok) return ok(c, { application: result.application }, 201);
  return refusal(result.reason === "pending" || result.reason === "verified" ? "exists" : "forbidden", {
    status: result.reason === "pending" || result.reason === "verified" ? 409 : 403,
    message: `${result.reason}: ${result.message}`,
  });
});

/** The "Needs you" item: organisations of this person whose application is waiting for review. */
routes.get("/me/verification", requireSession(), async (c) => ok(c, { pending: await pendingApplicationsFor(c.get("runtime").ports.d1, c.get("session")!.record.user_id) }));
