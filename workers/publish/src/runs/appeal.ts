import { refusal } from "@packserver/http";
import { Hono } from "hono";
import type { PublishRuntime } from "../bindings";
import { badRequest, readJson } from "../respond";
import { runById } from "./store";

/** The ceiling of an appeal note (REQ-VAL-040); the table's own check says the same. */
export const APPEAL_NOTE_MAX = 2000;
const MAX_BODY_BYTES = 16 * 1024;
const NO_STORE = { "cache-control": "no-store" };

const notFound = () => Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE });

/**
 * `POST /internal/runs/:id/appeal` for a person `web` has signed in: the one appeal a rejected version may carry.
 * The note is stored for the admin to read beside the report; nothing here reads it, so it reaches no model.
 */
export function appealRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  const { d1, clock } = runtime.ports;

  app.post("/runs/:id/appeal", async (c) => {
    const body = await readJson(c.req.raw, MAX_BODY_BYTES);
    const value = body.ok && typeof body.value === "object" && body.value !== null ? (body.value as Record<string, unknown>) : null;
    if (!value || typeof value.principal_id !== "string" || typeof value.note !== "string") return badRequest("expected { principal_id, note }");
    const run = await runById(d1, c.req.param("id"));
    const role = run ? (await d1.query("select role from scope_members where scope_id = ? and user_id = ?", [run.scope_id, value.principal_id])).rows[0]?.role : undefined;
    if (!run || run.kind !== "publish" || role === undefined) return notFound();

    const rejected = (await d1.query("select decision from review_decisions where run_id = ?", [run.id])).rows[0];
    if (!rejected || rejected.decision === "approve") return refusal("forbidden", { status: 409, message: "Only a rejected version can be appealed." });
    const note = value.note.trim();
    if (note.length === 0 || note.length > APPEAL_NOTE_MAX) return refusal("forbidden", { status: 400, message: `An appeal is between 1 and ${APPEAL_NOTE_MAX} characters.` });

    const at = new Date(clock.now()).toISOString();
    const inserted = await d1.query("insert or ignore into review_appeals (run_id, note, submitted_by, submitted_at) values (?, ?, ?, ?)", [run.id, note, value.principal_id, at]);
    if (inserted.meta.changes === 0) return refusal("exists", { message: "This version has been appealed already." });
    return Response.json({ run_id: run.id, state: "open" }, { status: 201, headers: NO_STORE });
  });

  return app;
}
