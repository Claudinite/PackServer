import {
  applicationOf, checkDomainProof, domainProofsOf, githubProofOf, proveGithubOrg, startDomainProof,
} from "@packserver/core/scopes";
import { scopeMfaPolicy } from "@packserver/core/identity";
import { refusal, requireSession } from "@packserver/http";
import { Hono, type Context } from "hono";
import type { WebEnv } from "../../context";
import { notFound, ok, sensitive, signedInPost, standing } from "../scopes/guard";
import { proofPorts } from "./proof-ports";

export const routes = new Hono<WebEnv>();

const orgOf = (c: Context<WebEnv>): string => c.req.param("org") ?? "";
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
async function jsonBody(c: Context<WebEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
/** What a proof-starting assertion is bound to: the organisation and the thing it is asked to prove. */
const bodyField = (field: string) => async (c: Context<WebEnv>): Promise<string> =>
  `${orgOf(c)}/${text(((await c.req.raw.clone().json().catch(() => null)) as Record<string, unknown> | null)?.[field])?.toLowerCase() ?? ""}`;

/** An organisation's verification settings: both proofs, the application and what the application still needs. */
routes.get("/orgs/:org/verification", requireSession(), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "maintainer", resource: "public" });
  if (who instanceof Response) return who;
  if (who.scope.kind !== "org") return notFound();
  const ports = proofPorts(c);
  const [domain, github, application, mfa] = await Promise.all([
    domainProofsOf(ports, who.scope.id),
    githubProofOf(ports, who.scope.id),
    applicationOf(ports.d1, who.scope.id),
    scopeMfaPolicy(ports.d1, who.scope.id),
  ]);
  return ok(c, { org: who.scope.name, you: who.role, domain, github, application, mfa });
});

/** Issues the token and says where to publish it; nothing is proven until "Check now" finds it. */
routes.post("/orgs/:org/verification/domain", sensitive("org.prove-domain", bodyField("domain")), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "owner", resource: "public" });
  if (who instanceof Response) return who;
  if (who.scope.kind !== "org") return refusal("forbidden", { message: "A personal scope cannot prove a domain." });
  const domain = text((await jsonBody(c)).domain);
  if (!domain) return refusal("forbidden", { status: 400, message: "domain: name the domain to prove." });
  const result = await startDomainProof(proofPorts(c), who.scope, domain);
  if (result.ok) return ok(c, { challenge: result.challenge }, 201);
  return refusal(result.reason === "has_domain" ? "exists" : "forbidden", { status: result.reason === "has_domain" ? 409 : 422, message: `${result.reason}: ${result.message}` });
});

/** "Check now". Reading a token the owner published proves control by itself, so it asks for no further assertion. */
routes.post("/orgs/:org/verification/domain/:challenge/check", signedInPost(), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "owner", resource: "public" });
  if (who instanceof Response) return who;
  const result = await checkDomainProof(proofPorts(c), who.scope, c.req.param("challenge"));
  if (result.status === "unknown_challenge") return notFound();
  if (result.status === "ended") return refusal("exists", { message: "ended: this proof is over; start a new one." });
  return ok(c, { result });
});

/** Proves a GitHub organisation by the installed App or by the person's own sign-in as one of its owners. */
routes.post("/orgs/:org/verification/github", sensitive("org.prove-github", bodyField("org")), async (c) => {
  const who = await standing(c, { scope: orgOf(c), need: "owner", resource: "public" });
  if (who instanceof Response) return who;
  if (who.scope.kind !== "org") return refusal("forbidden", { message: "A personal scope cannot prove a GitHub organisation." });
  const body = await jsonBody(c);
  const org = text(body.org);
  const method = body.method === "app" || body.method === "admin" ? body.method : undefined;
  if (!org || !method) return refusal("forbidden", { status: 400, message: "org and method: name the GitHub organisation and prove it by app or admin." });
  const result = await proveGithubOrg(proofPorts(c), who.scope, c.get("session")!.record.user_id, { org, method });
  if (result.ok) return ok(c, { github: { org: result.org, method: result.method } }, 201);
  return refusal(result.reason === "taken" || result.reason === "has_org" ? "exists" : "forbidden", {
    status: result.reason === "taken" || result.reason === "has_org" ? 409 : 403,
    message: `${result.reason}: ${result.message}`,
  });
});
