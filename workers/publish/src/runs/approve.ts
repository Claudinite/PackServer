import { RELEASE_HEADER } from "@packserver/schema";
import { refusal } from "@packserver/http";
import { Hono } from "hono";
import { z } from "zod";
import type { PublishRuntime } from "../bindings";
import { badRequest, readJson } from "../respond";
import { runById } from "./store";

const MAX_BODY_BYTES = 8 * 1024;
const NO_STORE = { "cache-control": "no-store" };

/** Where the validator applies a decision; no hostname of its own is public, so the origin is only a placeholder. */
const VALIDATOR_RESUME_URL = "http://validator.internal/internal/resume";

const Approve = z.object({ principal_id: z.string().min(1) });

const notFound = () => Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE });

/** The role the person holds in the run's scope, or null when they hold none. */
async function roleIn(runtime: PublishRuntime, scopeId: string, principalId: string): Promise<string | null> {
  const row = (await runtime.ports.d1.query("select role from scope_members where scope_id = ? and user_id = ?", [scopeId, principalId])).rows[0];
  return row ? String(row.role) : null;
}

/** Asks the validator to wake the run. A validator that cannot be reached loses nothing: its cron applies the approval row. */
async function wakeValidator(runtime: PublishRuntime, runId: string): Promise<void> {
  try {
    const res = await runtime.services.validator.fetch(VALIDATOR_RESUME_URL, {
      method: "POST",
      headers: { "content-type": "application/json", [RELEASE_HEADER]: runtime.version.releaseId },
      body: JSON.stringify({ run_id: runId }),
    });
    await res.arrayBuffer();
  } catch (error) {
    console.log(JSON.stringify({ event: "publish.approval_wake_failed", run_id: runId, reason: error instanceof Error ? error.message : String(error) }));
  }
}

/**
 * What `web` asks of `publish` once a person's per-action assertion has verified (REQ-PUB-019, REQ-VAL-052).
 * No public route reaches `/internal`; `web` names the person by `principal_id`, and only an owner of the
 * run's scope may approve, whatever role the assertion's account holds elsewhere.
 */
export function approveRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  const { d1, clock } = runtime.ports;

  app.post("/runs/:id/approve", async (c) => {
    const body = await readJson(c.req.raw, MAX_BODY_BYTES);
    const parsed = body.ok ? Approve.safeParse(body.value) : null;
    if (!parsed?.success) return badRequest("expected { principal_id }");
    const run = await runById(d1, c.req.param("id"));
    const waiting = run ? (await d1.query("select approved_at from run_approvals where run_id = ?", [run.id])).rows[0] : undefined;
    if (!run || !waiting) return notFound();
    const role = await roleIn(runtime, run.scope_id, parsed.data.principal_id);
    if (role === null) return notFound();
    if (role !== "owner") return refusal("forbidden", { message: "Only an owner of the scope can approve a version." });

    const at = new Date(clock.now()).toISOString();
    await d1.query("update run_approvals set approved_by = ?, approved_at = ? where run_id = ? and approved_at is null", [parsed.data.principal_id, at, run.id]);
    await wakeValidator(runtime, run.id);
    return Response.json({ run_id: run.id, state: "approved" }, { headers: NO_STORE });
  });

  return app;
}
