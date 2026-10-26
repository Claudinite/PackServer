import { createAudit } from "@packserver/core/audit";
import { approveRecovery, recoveryQueue } from "@packserver/core/identity";
import { refusal } from "@packserver/http";
import { syncClock } from "@packserver/ports";
import { Hono, type MiddlewareHandler } from "hono";
import type { AdminRuntime } from "../bindings";

const ACCESS_HEADER = "cf-access-jwt-assertion";
const NO_STORE = { "cache-control": "no-store" };

/** Delayed account recoveries waiting for an admin (REQ-ACC-015, REQ-ADMIN-007). Every call needs a verified Access assertion. */
export function recoveryRoutes(runtime: AdminRuntime): Hono<{ Variables: { admin: string } }> {
  const app = new Hono<{ Variables: { admin: string } }>();
  const { d1, clock, rng, queues, access } = runtime.ports;

  const verified: MiddlewareHandler<{ Variables: { admin: string } }> = async (c, next) => {
    await syncClock(clock);
    const assertion = c.req.header(ACCESS_HEADER);
    if (!assertion) return refusal("forbidden", { status: 401, message: "An Access assertion is required." });
    try {
      c.set("admin", (await access.verify(assertion)).email);
    } catch {
      return refusal("forbidden", { status: 401, message: "The Access assertion did not verify." });
    }
    return next();
  };
  app.use("/admin/recoveries", verified);
  app.use("/admin/recoveries/*", verified);

  app.get("/admin/recoveries", async (c) => c.json({ recoveries: await recoveryQueue({ d1, clock }) }, 200, NO_STORE));

  app.post("/admin/recoveries/:id/approve", async (c) => {
    const admin = c.get("admin");
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
