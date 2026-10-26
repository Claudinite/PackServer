import { isMfaPolicy, MFA_POLICIES, scopeMfaPolicy, setScopeMfaPolicy } from "@packserver/core/identity";
import { refusal, requireSession } from "@packserver/http";
import { Hono } from "hono";
import { recordAudit, type WebEnv } from "../../context";
import { ok, sensitive, standing } from "../scopes/guard";

export const routes = new Hono<WebEnv>();

const orgOf = (c: { req: { param(name: string): string } }): string => c.req.param("org");

routes.get("/orgs/:org/mfa-policy", requireSession(), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "maintainer", resource: "public" });
  if (who instanceof Response) return who;
  return ok(c, { org: who.scope.name, policy: await scopeMfaPolicy(c.get("runtime").ports.d1, who.scope.id), options: MFA_POLICIES });
});

/** What everyone acting for the organisation must have enrolled (REQ-ACC-018); only an owner sets it. */
routes.post("/orgs/:org/mfa-policy", sensitive("org.mfa-policy", orgOf), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "owner", resource: "public" });
  if (who instanceof Response) return who;
  const policy = ((await c.req.json().catch(() => ({}))) as { policy?: unknown }).policy;
  if (!isMfaPolicy(policy)) return refusal("forbidden", { status: 400, message: `policy: one of ${MFA_POLICIES.join(", ")}.` });
  const { d1, clock } = c.get("runtime").ports;
  await setScopeMfaPolicy({ d1, clock }, who.scope.id, policy, c.get("session")!.record.user_id);
  await recordAudit(c, c.get("session")!.record.user_id, "scope.mfa_policy.changed", who.scope.name, { policy });
  return ok(c, { org: who.scope.name, policy });
});
