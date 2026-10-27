import { actorOf } from "@packserver/core/admin";
import { clearScopeHold } from "@packserver/core/scopes";
import { adminRouter, NO_STORE } from "../access/context";

/** Publishing holds on handles (REQ-ADMIN-007); the delayed account recoveries beside them are in `queue/recoveries.ts`. */
export const routes = adminRouter();

routes.get("/admin/holds", async (c) => {
  const { rows } = await c.get("core").d1.query(
    "select name, kind, created_at from scopes where state = 'held' and not exists (select 1 from scope_disputes where scope_id = scopes.id and state = 'open' and held_scope = 1) order by name",
  );
  return c.json({ holds: rows.map((r) => ({ scope: String(r.name), kind: String(r.kind), since: String(r.created_at) })) }, 200, NO_STORE);
});

routes.post("/admin/scopes/:name/hold/clear", async (c) => {
  const core = c.get("core");
  const result = await clearScopeHold(core, c.req.param("name").replace(/^@/, ""));
  if (!result.ok) return c.json(result, result.reason === "unknown" ? 404 : 409, NO_STORE);
  await core.audit(actorOf(c.get("admin")), "admin.action", `scope:@${result.scope}`, { detail: { verb: "hold.clear" } });
  return c.json(result, 200, NO_STORE);
});
