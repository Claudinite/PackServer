import { actorOf } from "@packserver/core/admin";
import {
  actOnAbuse, blockReporter, decideModerationAppeal, dismissAbuse, flaggedReporters, heldComments, hidePack, hideReviewByModerator, MAX_REASON, openAbuseReports,
  openModerationAppeals, quarantinePack, recordSuit, releaseComment, removeComment, removeOnCopyrightNotice, suspendPublisher, type AbuseAction,
} from "@packserver/core/moderation";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { adminRouter, jsonBody, NO_STORE, stringField } from "../access/context";
import type { AdminRuntime } from "../bindings";
import { opsPorts } from "../ops/context";

const BAD_REQUEST = { ok: false, reason: "bad_request" } as const;
const STATUS: Record<string, ContentfulStatusCode> = { unknown: 404, not_open: 409, not_held: 409, wrong_target: 409, failed: 409 };

const reasonOf = (body: Record<string, unknown>): string | null => {
  const reason = stringField(body, "reason")?.trim();
  return reason && reason.length <= MAX_REASON ? reason : null;
};

/**
 * The moderation half of the admin app (REQ-ADMIN-002): abuse reports, the actions on versions, packs, reviews and publishers, appeals,
 * copyright removals, flagged reporters and held comments. Every action is audited with the admin as actor.
 */
export function moderationRoutes(runtime: AdminRuntime) {
  const routes = adminRouter();
  const ports = () => opsPorts(runtime).moderation;

  routes.get("/admin/moderation/abuse", async (c) => c.json({ reports: await openAbuseReports(ports().d1) }, 200, NO_STORE));

  routes.post("/admin/moderation/abuse/:id/dismiss", async (c) => {
    const result = await dismissAbuse(ports(), c.req.param("id"), c.get("admin").email);
    return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, 404, NO_STORE);
  });

  routes.post("/admin/moderation/abuse/:id/action", async (c) => {
    const body = await jsonBody(c.req.raw);
    const action = body && stringField(body, "action");
    const reason = body && reasonOf(body);
    if (!body || !reason || (action !== "quarantine" && action !== "yank" && action !== "hide_review" && action !== "suspend")) return c.json(BAD_REQUEST, 400, NO_STORE);
    const result = await actOnAbuse(ports(), c.get("admin").email, c.req.param("id"), { action, reason } as AbuseAction);
    return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, STATUS[result.reason] ?? 409, NO_STORE);
  });

  routes.post("/admin/moderation/packs/hide", async (c) => {
    const body = await jsonBody(c.req.raw);
    const pack = body && stringField(body, "pack");
    const reason = body && reasonOf(body);
    if (!pack || !reason) return c.json(BAD_REQUEST, 400, NO_STORE);
    const result = await hidePack(ports(), actorOf(c.get("admin")), pack, reason);
    if (!result.ok) return c.json({ ok: false, reason: "unknown", message: result.message }, 404, NO_STORE);
    await ports().audit(actorOf(c.get("admin")), "admin.action", `pack:${pack}`, { detail: { verb: "pack.hide", reason } });
    return c.json(result, 200, NO_STORE);
  });

  routes.post("/admin/moderation/packs/quarantine", async (c) => {
    const body = await jsonBody(c.req.raw);
    const pack = body && stringField(body, "pack");
    const reason = body && reasonOf(body);
    if (!pack || !reason) return c.json(BAD_REQUEST, 400, NO_STORE);
    const result = await quarantinePack(ports(), actorOf(c.get("admin")), pack, reason);
    if (!result.ok) return c.json({ ok: false, reason: "unknown", message: result.message }, 404, NO_STORE);
    await ports().audit(actorOf(c.get("admin")), "admin.action", `pack:${pack}`, { detail: { verb: "pack.quarantine", reason } });
    return c.json(result, 200, NO_STORE);
  });

  routes.post("/admin/moderation/reviews/:id/hide", async (c) => {
    const body = await jsonBody(c.req.raw);
    const reason = body && reasonOf(body);
    if (!reason) return c.json(BAD_REQUEST, 400, NO_STORE);
    const result = await hideReviewByModerator(ports(), c.get("admin").email, c.req.param("id"), reason);
    if (!result.ok) return c.json({ ok: false, reason: "unknown", message: result.message }, 404, NO_STORE);
    await ports().audit(actorOf(c.get("admin")), "admin.action", `review:${c.req.param("id")}`, { detail: { verb: "review.hide", reason } });
    return c.json(result, 200, NO_STORE);
  });

  routes.post("/admin/moderation/scopes/:name/suspend", async (c) => {
    const body = await jsonBody(c.req.raw);
    const reason = body && reasonOf(body);
    if (!reason) return c.json(BAD_REQUEST, 400, NO_STORE);
    const result = await suspendPublisher(ports(), c.get("admin").email, c.req.param("name"), reason);
    if (!result.ok) return c.json({ ok: false, reason: "unknown", message: result.message }, 404, NO_STORE);
    await ports().audit(actorOf(c.get("admin")), "admin.action", `scope:@${c.req.param("name").replace(/^@/, "")}`, { detail: { verb: "publisher.suspend", reason } });
    return c.json(result, 200, NO_STORE);
  });

  routes.get("/admin/moderation/appeals", async (c) => c.json({ appeals: await openModerationAppeals(ports().d1) }, 200, NO_STORE));

  routes.post("/admin/moderation/appeals/:actionId/decision", async (c) => {
    const body = await jsonBody(c.req.raw);
    const outcome = body && stringField(body, "outcome");
    if (outcome !== "upheld" && outcome !== "denied") return c.json(BAD_REQUEST, 400, NO_STORE);
    const result = await decideModerationAppeal(ports(), c.req.param("actionId"), c.get("admin").email, outcome);
    return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, STATUS[result.reason] ?? 409, NO_STORE);
  });

  routes.post("/admin/moderation/dmca", async (c) => {
    const body = await jsonBody(c.req.raw);
    const pack = body && stringField(body, "pack");
    const version = body && stringField(body, "version");
    const complainant = body && stringField(body, "complainant");
    if (!pack || !version || !complainant || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(complainant)) return c.json(BAD_REQUEST, 400, NO_STORE);
    const result = await removeOnCopyrightNotice(ports(), c.get("admin").email, { pack, version, complainant });
    return result.ok ? c.json(result, 200, NO_STORE) : c.json({ ok: false, reason: "failed", message: result.message }, 409, NO_STORE);
  });

  routes.post("/admin/moderation/dmca/:caseId/suit", async (c) => {
    const result = await recordSuit(ports(), c.req.param("caseId"), c.get("admin").email);
    return result.ok ? c.json(result, 200, NO_STORE) : c.json({ ok: false, reason: "not_open", message: result.message }, 409, NO_STORE);
  });

  routes.get("/admin/moderation/flags", async (c) => c.json({ reporters: await flaggedReporters(ports().d1) }, 200, NO_STORE));

  routes.post("/admin/moderation/reporters/:id/block", async (c) => {
    const result = await blockReporter(ports(), c.req.param("id"), c.get("admin").email);
    return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, 404, NO_STORE);
  });

  routes.get("/admin/moderation/comments", async (c) => c.json({ comments: await heldComments(ports().d1) }, 200, NO_STORE));

  routes.post("/admin/moderation/comments/:id/release", async (c) => {
    const result = await releaseComment(ports(), c.req.param("id"), c.get("admin").email);
    return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, STATUS[result.reason] ?? 409, NO_STORE);
  });

  routes.post("/admin/moderation/comments/:id/remove", async (c) => {
    const body = await jsonBody(c.req.raw);
    const reason = body && reasonOf(body);
    if (!reason) return c.json(BAD_REQUEST, 400, NO_STORE);
    const result = await removeComment(ports(), c.req.param("id"), c.get("admin").email, reason);
    return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, STATUS[result.reason] ?? 409, NO_STORE);
  });

  return routes;
}
