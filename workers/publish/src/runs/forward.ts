import { Hono } from "hono";
import type { PublishRuntime } from "../bindings";

/**
 * The owner's verbs on a run sit under `/api/publish/runs/*`, a path this Worker's route owns on every
 * real host, while the session, CSRF and passkey checks they need live in `web`; the request goes there as it came.
 */
export function forwardRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  app.on(["GET", "POST"], "/runs/:id/:verb{approve|approval|appeal}", (c) => runtime.services.web.fetch(c.req.raw));
  return app;
}
