import { acceptInvitation, createOrg, deleteOrg, invite, isScopeRole, listPeople, pendingFor, removeInvitation, removePerson, setRole, type PeopleResult } from "@packserver/core/scopes";
import { refusal, requireSession } from "@packserver/http";
import { Hono, type Context } from "hono";
import type { WebEnv } from "../../context";
import { notFound, ok, scopePorts, sensitive, signedInPost, standing } from "../scopes/guard";

export const routes = new Hono<WebEnv>();

const badRequest = (message: string) => refusal("forbidden", { status: 400, message });

async function jsonBody(c: Context<WebEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

function peopleRefusal(result: Extract<PeopleResult, { ok: false }>): Response {
  if (result.reason === "unknown_person" || result.reason === "not_a_person") return refusal("forbidden", { status: 404, message: result.message });
  if (result.reason === "personal_scope") return refusal("forbidden", { message: result.message });
  if (result.reason === "unverified_address") return refusal("forbidden", { status: 400, message: result.message });
  return refusal("exists", { message: result.message });
}

/** What an assertion for these verbs is bound to: the organisation, or the person within it. */
const orgOf = (c: Context<WebEnv>): string => c.req.param("org") ?? "";
const personOf = (c: Context<WebEnv>): string => `${orgOf(c)}/${c.req.param("handle")}`;

/** A scope's people. A personal scope answers like an organisation, except that it refuses to gain anyone. */
const orgStanding = (c: Context<WebEnv>, need: "owner" | "maintainer") => standing(c, { scope: c.req.param("org") ?? "", need, resource: "public" });

routes.post("/orgs", sensitive("org.create", async (c) => text(((await c.req.raw.clone().json().catch(() => null)) as { name?: unknown } | null)?.name) ?? ""), async (c) => {
  const name = text((await jsonBody(c)).name);
  if (!name) return badRequest("name: name the organisation.");
  const result = await createOrg(scopePorts(c), c.get("session")!.record.user_id, name);
  if (result.ok) return ok(c, { org: { name: result.scope.name, role: "owner" } }, 201);
  if (result.reason === "taken") return refusal("exists", { message: `${result.reason}: ${result.message}` });
  return refusal("forbidden", { status: result.reason === "format" || result.reason === "no_handle" ? 422 : 403, message: `${result.reason}: ${result.message}` });
});

routes.get("/orgs/:org/people", requireSession(), async (c) => {
  const who = await orgStanding(c, "maintainer");
  if (who instanceof Response) return who;
  return ok(c, { org: who.scope.name, you: who.role, ...(await listPeople(c.get("runtime").ports.d1, who.scope.id)) });
});

routes.post("/orgs/:org/people", sensitive("org.invite", orgOf), async (c) => {
  const who = await orgStanding(c, "owner");
  if (who instanceof Response) return who;
  const body = await jsonBody(c);
  const handle = text(body.handle);
  const email = text(body.email);
  const role = body.role ?? "maintainer";
  if (!isScopeRole(role)) return badRequest("role: owner or maintainer.");
  const target = handle ? { handle } : email ? { email } : undefined;
  if (!target) return badRequest("handle or email: name the person to invite.");
  const result = await invite(scopePorts(c), who.scope, c.get("session")!.record.user_id, target, role);
  return result.ok ? ok(c, { outcome: result.outcome }, 201) : peopleRefusal(result);
});

routes.post("/orgs/:org/people/:handle/role", sensitive("org.set-role", personOf), async (c) => {
  const who = await orgStanding(c, "owner");
  if (who instanceof Response) return who;
  const role = (await jsonBody(c)).role;
  if (!isScopeRole(role)) return badRequest("role: owner or maintainer.");
  const result = await setRole(scopePorts(c), who.scope, c.req.param("handle"), role);
  return result.ok ? ok(c, { outcome: result.outcome }) : peopleRefusal(result);
});

routes.delete("/orgs/:org/people/:handle", sensitive("org.remove", personOf), async (c) => {
  const who = await orgStanding(c, "owner");
  if (who instanceof Response) return who;
  const result = await removePerson(scopePorts(c), who.scope, c.req.param("handle"));
  return result.ok ? ok(c, { outcome: result.outcome }) : peopleRefusal(result);
});

routes.delete("/orgs/:org/invitations/:id", sensitive("org.remove", (c) => `${orgOf(c)}/invitations/${c.req.param("id")}`), async (c) => {
  const who = await orgStanding(c, "owner");
  if (who instanceof Response) return who;
  const result = await removeInvitation(c.get("runtime").ports.d1, who.scope, c.req.param("id"));
  return result.ok ? ok(c, { outcome: result.outcome }) : peopleRefusal(result);
});

/** Refused while the organisation owns a pack; the name is retired for good (REQ-SCOPE-012, REQ-SCOPE-013). */
routes.delete("/orgs/:org", sensitive("org.delete", orgOf), async (c) => {
  const who = await orgStanding(c, "owner");
  if (who instanceof Response) return who;
  const result = await deleteOrg(scopePorts(c), who.scope);
  if (result.ok) return ok(c, { deleted: who.scope.name });
  return refusal("forbidden", { status: 409, message: `${result.reason}: ${result.message}` });
});

routes.get("/invitations", requireSession(), async (c) => ok(c, { invitations: await pendingFor(c.get("runtime").ports.d1, c.get("session")!.record.user_id) }));

routes.post("/invitations/:id/accept", signedInPost(), async (c) => {
  const result = await acceptInvitation(scopePorts(c), c.get("session")!.record.user_id, c.req.param("id"));
  return result.ok ? ok(c, { outcome: result.outcome }) : notFound();
});
