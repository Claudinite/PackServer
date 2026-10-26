import { addGrant, isAccountId, listGrants, removeGrant } from "@packserver/core/access";
import { refusal, requireSession } from "@packserver/http";
import { PackName } from "@packserver/schema";
import { Hono, type Context } from "hono";
import { runtimeOf, type WebEnv } from "../../context";
import { isScopeRole, loadScope, satisfies } from "@packserver/core/scopes";
import { notFound, ok, signedInPost } from "../scopes/guard";

export const routes = new Hono<WebEnv>();

/**
 * The pack's id when the caller maintains its scope and the pack is private; otherwise the response
 * to send. Someone with no part in the scope is told the pack does not exist; a person of the scope
 * who may not manage it is told so.
 */
async function target(c: Context<WebEnv>): Promise<{ packId: string } | Response> {
  const scope = c.req.param("scope") ?? "";
  const name = c.req.param("name") ?? "";
  if (!PackName.safeParse(`${scope}/${name}`).success) return notFound();
  const { d1 } = runtimeOf(c).ports;
  const userId = c.get("session")?.record.user_id;
  const found = await loadScope(d1, scope.slice(1));
  const held = found && userId ? (await d1.query("select role from scope_members where scope_id = ? and user_id = ?", [found.id, userId])).rows[0] : undefined;
  const { rows } = found ? await d1.query("select id from packs where scope_id = ? and name = ? and visibility = 'private'", [found.id, name]) : { rows: [] };
  if (!held || !rows[0]) return notFound();
  if (!isScopeRole(held.role) || !satisfies(held.role, "maintainer")) return refusal("forbidden", { message: "Only the scope's owners and maintainers can do this." });
  return { packId: rows[0].id as string };
}

const invalid = (message: string) => refusal("forbidden", { status: 422, message });

/** The allowlist of GitHub accounts, by numeric id. A maintainer manages it; the passkey and audit steps belong to the access page. */
routes.get("/packs/:scope/:name/grants", requireSession(), async (c) => {
  const found = await target(c);
  if (found instanceof Response) return found;
  return ok(c, { grants: await listGrants(runtimeOf(c).ports.d1, found.packId) });
});

routes.post("/packs/:scope/:name/grants", signedInPost(), async (c) => {
  const found = await target(c);
  if (found instanceof Response) return found;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== "object" || body === null) return invalid("format: a JSON object is required.");
  if (!isAccountId(body.account_id)) return invalid("account_id: GitHub's numeric account id is required, not a login.");
  if (body.account_type !== "user" && body.account_type !== "organization") return invalid("account_type: user or organization.");
  if (body.private_repos_only !== undefined && typeof body.private_repos_only !== "boolean") return invalid("private_repos_only: true or false.");
  const { d1, clock, rng } = runtimeOf(c).ports;
  const grant = await addGrant(
    { d1, clock, rng },
    {
      packId: found.packId,
      accountId: body.account_id,
      accountType: body.account_type,
      ...(body.private_repos_only === undefined ? {} : { privateReposOnly: body.private_repos_only }),
      by: c.get("session")!.record.user_id,
    },
  );
  return ok(c, { grant }, 201);
});

routes.delete("/packs/:scope/:name/grants/:accountId", signedInPost(), async (c) => {
  const found = await target(c);
  if (found instanceof Response) return found;
  const removed = await removeGrant(runtimeOf(c).ports, found.packId, c.req.param("accountId") ?? "");
  return removed ? ok(c, { removed: true }) : notFound();
});
