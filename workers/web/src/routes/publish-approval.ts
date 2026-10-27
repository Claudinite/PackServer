import { HELD_ACTION_NAMES } from "@packserver/core/identity";
import { requireSession } from "@packserver/http";
import { RELEASE_HEADER } from "@packserver/schema";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { recordAudit, runtimeOf, type WebEnv } from "../context";
import { notFound, ok, sensitive, signedInPost, standing } from "./scopes/guard";

/**
 * `registry.claudinite.com/api/publish/*` belongs to the publish Worker's route in production, and a route pattern cannot
 * carve a path out of it, so the web Worker serves these under `/api/approvals/runs` as well.
 */
const verbs = new Hono<WebEnv>();
export const routes = new Hono();

/** Where `publish` takes what a signed-in person decided; no hostname of its own is public, so the origin is only a placeholder. */
const PUBLISH = "http://publish.internal/internal/runs";

interface RunFacts {
  id: string;
  scope_id: string;
  scope: string;
  pack: string;
  version: string;
  visibility: "public" | "private";
}

async function runFacts(c: Context<WebEnv>): Promise<RunFacts | null> {
  const row = (
    await runtimeOf(c).ports.d1.query(
      `select r.id, r.scope_id, s.name as scope, r.pack_name, r.version, p.visibility
         from validation_runs r join scopes s on s.id = r.scope_id
         left join packs p on p.scope_id = r.scope_id and p.name = r.pack_name
        where r.id = ? and r.kind = 'publish'`,
      [c.req.param("id") ?? ""],
    )
  ).rows[0];
  return row
    ? { id: String(row.id), scope_id: String(row.scope_id), scope: String(row.scope), pack: String(row.pack_name), version: String(row.version), visibility: row.visibility === "private" ? "private" : "public" }
    : null;
}

/** The signed-in person's standing as an owner of the run's scope; a refusal comes back as the response to send. */
async function ownerOf(c: Context<WebEnv>, run: RunFacts, need: "owner" | "maintainer"): Promise<Response | null> {
  const who = await standing(c, { scope: run.scope, need, resource: run.visibility });
  return who instanceof Response ? who : null;
}

async function askPublish(c: Context<WebEnv>, run: RunFacts, verb: "approve" | "appeal", body: Record<string, unknown>): Promise<Response> {
  const runtime = runtimeOf(c);
  const res = await runtime.services.publish.fetch(`${PUBLISH}/${run.id}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", [RELEASE_HEADER]: runtime.version.releaseId },
    body: JSON.stringify({ principal_id: c.get("session")!.record.user_id, ...body }),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The approval sheet: what is new first, then everything else the version changes, for an owner who is about to approve. */
verbs.get("/:id/approval", requireSession<WebEnv>(), async (c) => {
  const run = await runFacts(c);
  if (!run) return notFound();
  const refused = await ownerOf(c, run, "owner");
  if (refused) return refused;
  const row = (await runtimeOf(c).ports.d1.query("select reasons, sheet, requested_at, approved_at from run_approvals where run_id = ?", [run.id])).rows[0];
  if (!row) return notFound();
  return ok(c, {
    run_id: run.id,
    pack: `@${run.scope}/${run.pack}`,
    version: run.version,
    state: row.approved_at ? "approved" : "awaiting",
    reasons: JSON.parse(String(row.reasons)),
    requested_at: String(row.requested_at),
    sheet: JSON.parse(String(row.sheet)),
  });
});

/** An owner approves a version that waits for them (REQ-PUB-019, REQ-VAL-052), with a passkey assertion made for this run. */
verbs.post("/:id/approve", sensitive(HELD_ACTION_NAMES.publishApprove, (c) => c.req.param("id") ?? ""), async (c) => {
  const run = await runFacts(c);
  if (!run) return notFound();
  const refused = await ownerOf(c, run, "owner");
  if (refused) return refused;
  const waiting = (await runtimeOf(c).ports.d1.query("select approved_at from run_approvals where run_id = ?", [run.id])).rows[0];
  if (!waiting) return notFound();
  const userId = c.get("session")!.record.user_id;
  if (!waiting.approved_at) await recordAudit(c, userId, "publish.approved", `version:@${run.scope}/${run.pack}@${run.version}`, { version: run.version }, run.scope_id);
  return askPublish(c, run, "approve", {});
});

const Appeal = z.object({ note: z.string() });

/** The publisher's one appeal against a rejected version; the note goes to the admin's queue and nowhere else (REQ-VAL-040). */
verbs.post("/:id/appeal", signedInPost(), async (c) => {
  const run = await runFacts(c);
  if (!run) return notFound();
  const refused = await ownerOf(c, run, "maintainer");
  if (refused) return refused;
  const parsed = Appeal.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad-request", message: "expected { note }" }, { status: 400, headers: { "cache-control": "no-store" } });
  return askPublish(c, run, "appeal", { note: parsed.data.note });
});

// The app mounts this router with the request context its handlers read.
routes.route("/publish/runs", verbs as unknown as Hono);
routes.route("/approvals/runs", verbs as unknown as Hono);
