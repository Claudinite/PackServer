import { createAudit } from "@packserver/core/audit";
import { approveRecovery, recoveryQueue } from "@packserver/core/identity";
import type { AdminRuntime } from "../bindings";
import { adminRouter } from "../access/context";

const NO_STORE = { "cache-control": "no-store" };

/** Delayed account recoveries waiting for an admin (REQ-ACC-015, REQ-ADMIN-007); the Access guard has admitted the caller by the time a route runs. */
export function recoveryRoutes(runtime: AdminRuntime) {
  const app = adminRouter();
  const { d1, clock, rng, queues } = runtime.ports;

  app.get("/admin/recoveries", async (c) => c.json({ recoveries: await recoveryQueue({ d1, clock }) }, 200, NO_STORE));

  app.post("/admin/recoveries/:id/approve", async (c) => {
    const admin = c.get("admin").email;
    const queue = queues["AUDIT_QUEUE"];
    if (!queue) throw new Error("the audit queue is not bound");
    const audit = createAudit({ clock, rng, queue, d1 }, { ipKey: "" });
    const result = await approveRecovery({ d1, clock }, c.req.param("id"), admin, async (userId) => {
      await audit({ kind: "admin", id: admin }, "recovery.approved", c.req.param("id"), { user_id: userId });
    });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 409;
      return c.json({ ok: false, reason: result.reason, ...(result.ready_at ? { ready_at: result.ready_at } : {}) }, status, NO_STORE);
    }
    return c.json({ ok: true }, 200, NO_STORE);
  });

  return app;
}
