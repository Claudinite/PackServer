import { isPageId, PAGES, verifyHook, verifyMute, type HookSource, type PageId } from "@packserver/core/alerts";
import type { Telemetry } from "@packserver/core/telemetry";
import { syncClock, type Clock } from "@packserver/ports";
import { Hono } from "hono";
import { z } from "zod";
import type { Detection } from "../alerts/detect";
import type { AlertRouter } from "../router/router";

const NO_STORE = { "cache-control": "no-store" };
/** An alert is a few fields; anything larger is not one. */
const MAX_BODY_BYTES = 8192;

export interface HookDeps {
  clock: Clock;
  router: AlertRouter;
  emit: Telemetry["emit"];
  mode: () => Promise<"pre-launch" | "launch">;
  /** Each source's own secret; one that is absent verifies nothing. */
  secrets: Record<HookSource, () => Promise<string | undefined>>;
  muteKey: () => Promise<string | undefined>;
}

/** The pages Cloudflare's own notifications back up, named by the notification policy. */
export const MONITOR_PAGES = ["page.read_path_burn", "page.hash_mismatch", "page.monitoring_dead"] as const satisfies readonly PageId[];

const MonitorBody = z.object({ name: z.enum(MONITOR_PAGES), count: z.number().int().min(0).max(1_000_000).optional() });
const WitnessBody = z.discriminatedUnion("check", [
  z.object({ check: z.literal("site"), status: z.enum(["up", "down"]), consecutive_failures: z.number().int().min(0).max(1_000_000) }),
  z.object({ check: z.literal("judge_heartbeat"), status: z.enum(["up", "down"]) }),
]);
const IssueBody = z.object({
  action: z.string().max(40),
  issue: z.object({ title: z.string().max(300) }),
});

/** Reads a body up to the limit and stops there, so a body that lies about its length is never held whole. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const detection = (page: PageId, key: string, fields: Detection["fields"]): Detection => ({ target: { kind: "page", page, key }, fields, actions: [] });

/** The judge's inbound hooks. Each source is verified with its own scheme and secret before its body is read as anything. */
export function hookRoutes(deps: HookDeps): Hono {
  const app = new Hono();
  const reject = (c: { json: (b: unknown, s: 401 | 413 | 400, h: Record<string, string>) => Response }, source: string, reason: string, status: 401 | 413 | 400): Response => {
    deps.emit("monitoring.alert_rejected", { source, reason });
    return c.json({ error: reason }, status, NO_STORE);
  };

  async function authenticated(source: HookSource, c: { req: { header(n: string): string | undefined; raw: Request } }): Promise<{ body: string } | { reason: string; status: 401 | 413 }> {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { reason: "too_large", status: 413 };
    const body = await readLimited(c.req.raw, MAX_BODY_BYTES);
    if (body === null) return { reason: "too_large", status: 413 };
    await syncClock(deps.clock);
    const check = await verifyHook(source, { header: (n) => c.req.header(n), body }, await deps.secrets[source](), deps.clock.now());
    return check.ok ? { body } : { reason: check.reason, status: 401 };
  }

  function parse<T>(schema: z.ZodType<T>, body: string): T | null {
    try {
      const parsed = schema.safeParse(JSON.parse(body));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  app.post("/hooks/monitors", async (c) => {
    const auth = await authenticated("monitors", c);
    if (!("body" in auth)) return reject(c, "monitors", auth.reason, auth.status);
    const parsed = parse(MonitorBody, auth.body);
    if (!parsed) return reject(c, "monitors", "unknown_alert", 400);
    const raised = await deps.router.raise(detection(parsed.name, parsed.name, { count: parsed.count }), await deps.mode());
    return c.json({ ok: true, dropped: raised.dropped }, 202, NO_STORE);
  });

  app.post("/hooks/witness", async (c) => {
    const auth = await authenticated("witness", c);
    if (!("body" in auth)) return reject(c, "witness", auth.reason, auth.status);
    const parsed = parse(WitnessBody, auth.body);
    if (!parsed) return reject(c, "witness", "unknown_alert", 400);
    // One failed probe is noise; the second in a row is the page. The dead man's switch pages on its first report.
    const page: PageId | null =
      parsed.status === "up" ? null : parsed.check === "judge_heartbeat" ? "page.monitoring_dead" : parsed.consecutive_failures >= 2 ? "page.site_down_external" : null;
    if (page === null) return c.json({ ok: true, dropped: null }, 202, NO_STORE);
    const raised = await deps.router.raise(detection(page, page, parsed.check === "site" ? { count: parsed.consecutive_failures } : {}), await deps.mode());
    return c.json({ ok: true, dropped: raised.dropped }, 202, NO_STORE);
  });

  // GitHub's `issues` events for the ops repository: closing a page's ticket acknowledges that page.
  app.post("/hooks/issues", async (c) => {
    const auth = await authenticated("issues", c);
    if (!("body" in auth)) return reject(c, "issues", auth.reason, auth.status);
    const parsed = parse(IssueBody, auth.body);
    if (!parsed) return reject(c, "issues", "unknown_alert", 400);
    const id = /^\[(page\.[a-z_]+)\]/.exec(parsed.issue.title)?.[1];
    if (parsed.action !== "closed" || !isPageId(id)) return c.json({ ok: true, acknowledged: false }, 202, NO_STORE);
    return c.json({ ok: true, acknowledged: await deps.router.acknowledge(id) }, 202, NO_STORE);
  });

  // A mail scanner opens links, so the link only asks and the form posts.
  app.get("/hooks/mute", async (c) => {
    const checked = await muteCheck(c.req.query());
    if (!checked.ok) return c.text("This mute link is not valid.", 400, NO_STORE);
    const q = new URLSearchParams({ page: checked.page, until: String(checked.until), sig: c.req.query("sig") ?? "" });
    return c.html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mute</title><form method="post" action="/hooks/mute?${q.toString().replace(/&/g, "&amp;")}"><p>Mute ${PAGES[checked.page].id} until ${new Date(checked.until).toISOString()}?</p><button>Mute</button></form>`,
      200,
      NO_STORE,
    );
  });
  app.post("/hooks/mute", async (c) => {
    const checked = await muteCheck(c.req.query());
    if (!checked.ok) return reject(c, "mute", checked.reason, 401);
    await deps.router.mute(checked.page, checked.until);
    return c.text(`${checked.page} is muted until ${new Date(checked.until).toISOString()}.`, 200, NO_STORE);
  });

  async function muteCheck(query: Record<string, string>) {
    await syncClock(deps.clock);
    const key = await deps.muteKey();
    if (!key) return { ok: false as const, reason: "unconfigured" };
    return verifyMute(key, query, deps.clock.now());
  }

  return app;
}
