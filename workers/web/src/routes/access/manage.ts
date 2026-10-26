import { addGrant, isAccountId, listGrants, removeGrant } from "@packserver/core/access";
import { refusal, requireSession } from "@packserver/http";
import { Hono, type Context } from "hono";
import { recordAudit, runtimeOf, type WebEnv } from "../../context";
import { notFound, ok, scopePorts, sensitive, standing } from "../scopes/guard";
import { auditTarget, findPack, loadAccess, type PackRow } from "./store";

export const routes = new Hono<WebEnv>();

/** The target an assertion for this pack is made for: the pack's name without its `@`. */
const systemName = (c: Context<WebEnv>): string => `${(c.req.param("scope") ?? "").replace(/^@/, "")}/${c.req.param("name")}`;

/** What a request body names, read from a copy so the handler still finds the body unread. */
async function bodyOf(c: Context<WebEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.raw.clone().json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

const accountNamed = async (c: Context<WebEnv>): Promise<string> => {
  const named = (await bodyOf(c)).account_id;
  return typeof named === "string" ? named : "";
};

/**
 * The pack and the caller's standing on its scope. A pack the caller has no standing on is
 * answered as one that does not exist, whether it is private or absent (REQ-PRIV-001, REQ-PRIV-015).
 */
async function packFor(c: Context<WebEnv>, need: "maintainer" | "owner"): Promise<{ pack: PackRow; role: "owner" | "maintainer" } | Response> {
  const scope = (c.req.param("scope") ?? "").replace(/^@/, "");
  const pack = await findPack(runtimeOf(c).ports.d1, scope, c.req.param("name") ?? "");
  if (!pack) return notFound();
  const who = await standing(c, { scope, need: "maintainer", resource: "private" });
  if (who instanceof Response) return who;
  // A maintainer already knows the pack exists, so an owner-only action is refused, not hidden.
  if (need === "owner" && who.role !== "owner") return refusal("forbidden", { message: "Only an owner can do this." });
  return { pack, role: who.role };
}

/** The owner's view: visibility, the allowlist with who added each entry and when it last read, the reads, and the changes (REQ-PRIV-012). */
routes.get("/access/:scope/:name", requireSession(), async (c) => {
  const found = await packFor(c, "maintainer");
  if (found instanceof Response) return found;
  return ok(c, { ...(await loadAccess(runtimeOf(c).ports.d1, found.pack)), you: found.role });
});

const SCOPE_PATH = "/packs/:scope/:name";

routes.post(`${SCOPE_PATH}/grants`, sensitive("grant.add", async (c) => `${systemName(c)}:${await accountNamed(c)}`), async (c) => {
  const found = await packFor(c, "maintainer");
  if (found instanceof Response) return found;
  const { pack } = found;
  if (pack.visibility !== "private") return refusal("forbidden", { status: 409, message: "Only a private pack has an allowlist." });
  const body = await bodyOf(c);
  if (!isAccountId(body.account_id)) return refusal("forbidden", { status: 422, message: "account_id: use GitHub's numeric account id, not the login." });
  if (body.private_repos_only !== undefined && typeof body.private_repos_only !== "boolean") {
    return refusal("forbidden", { status: 422, message: "private_repos_only: true or false." });
  }
  const ports = scopePorts(c);
  const before = (await listGrants(ports.d1, pack.id)).find((g) => g.account_id === body.account_id);
  const grant = await addGrant(ports, {
    packId: pack.id,
    accountId: body.account_id,
    accountType: "user",
    privateReposOnly: body.private_repos_only ?? true,
    by: c.get("session")!.record.user_id,
  });
  await recordAudit(c, c.get("session")!.record.user_id, "grant.changed", auditTarget(pack, grant.account_id), { role: "read", change: before ? "updated" : "added" }, pack.scopeId);
  return ok(c, { grant }, before ? 200 : 201);
});

routes.delete(`${SCOPE_PATH}/grants/:account`, sensitive("grant.remove", (c) => `${systemName(c)}:${c.req.param("account")}`), async (c) => {
  const found = await packFor(c, "maintainer");
  if (found instanceof Response) return found;
  const { pack } = found;
  const account = c.req.param("account") ?? "";
  if (!isAccountId(account) || !(await removeGrant(scopePorts(c), pack.id, account))) return notFound();
  await recordAudit(c, c.get("session")!.record.user_id, "grant.changed", auditTarget(pack, account), { role: "read", change: "removed" }, pack.scopeId);
  return ok(c, { removed: true });
});

/**
 * Only an owner changes visibility. Going public is permanent and says so: the request must carry
 * the confirmation as well as the assertion. Going private affects versions published from then on.
 */
routes.post(`${SCOPE_PATH}/visibility`, sensitive("pack.visibility", (c) => systemName(c)), async (c) => {
  const found = await packFor(c, "owner");
  if (found instanceof Response) return found;
  const { pack } = found;
  const body = await bodyOf(c);
  if (body.visibility !== "public" && body.visibility !== "private") return refusal("forbidden", { status: 422, message: "visibility: public or private." });
  if (body.visibility === pack.visibility) return ok(c, { visibility: pack.visibility, changed: false });
  if (body.visibility === "public" && body.confirm !== true) {
    return refusal("forbidden", { status: 422, message: "confirm: making a pack public is permanent; send confirm: true to go ahead." });
  }
  const { d1 } = runtimeOf(c).ports;
  await d1.query("update packs set visibility = ? where id = ?", [body.visibility, pack.id]);
  const userId = c.get("session")!.record.user_id;
  await recordAudit(c, userId, "visibility.changed", auditTarget(pack), { from: pack.visibility, to: body.visibility }, pack.scopeId);
  const reindex = runtimeOf(c).ports.queues.REINDEX_QUEUE;
  if (!reindex) throw new Error("the reindex queue is not bound");
  await reindex.send({ schema: 1, type: "scope.proof_changed", scope: pack.scope, change: "visibility_changed" });
  return ok(c, { visibility: body.visibility, changed: true });
});
