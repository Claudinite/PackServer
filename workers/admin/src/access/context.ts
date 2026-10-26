import type { AdminIdentity, AdminPorts } from "@packserver/core/admin";
import { createAudit } from "@packserver/core/audit";
import { Hono } from "hono";
import type { AdminRuntime } from "../bindings";

/** What the Access guard leaves for the routes behind it. */
export type AdminEnv = { Variables: { admin: AdminIdentity; core: AdminPorts } };

export const adminRouter = (): Hono<AdminEnv> => new Hono<AdminEnv>();

/** The ports the admin app's decisions run on, built once per request. */
export function adminPorts(runtime: AdminRuntime): AdminPorts {
  const { clock, rng, d1, mail, dns, wellKnown, queues, workflows, r2 } = runtime.ports;
  const audit = queues["AUDIT_QUEUE"];
  const reindex = queues["REINDEX_QUEUE"];
  const workflow = workflows["VALIDATE_PACK"];
  if (!audit || !reindex || !workflow) throw new Error("the admin Worker is missing a queue or workflow binding");
  return {
    clock,
    rng,
    d1,
    mail,
    dns,
    wellKnown,
    reindex,
    workflows: workflow,
    validationReports: r2["VALIDATION_REPORTS"]!,
    siteOrigin: runtime.config?.siteOrigin ?? "",
    audit: createAudit({ clock, rng, queue: audit, d1 }, { ipKey: "" }),
  };
}

export const NO_STORE = { "cache-control": "no-store" };

/** The JSON body of a state-changing call; a form or a text body is refused, so a cross-site form cannot reach an action. */
export async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const stringField = (body: Record<string, unknown>, name: string): string | undefined => (typeof body[name] === "string" ? (body[name] as string) : undefined);
