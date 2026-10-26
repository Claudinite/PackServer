import { refusal } from "@packserver/http";
import { Hono } from "hono";
import type { PublishRuntime } from "../bindings";
import { bearer } from "../respond";
import { credentialBySecret } from "../upload/credentials";
import { milestonesOf, runById, runView } from "./store";

const NO_STORE = { "cache-control": "no-store" };

/** `GET /api/publish/runs/<id>` for the credential that started the run, and the staged-approval route a later task fills in. */
export function runRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  const { d1, clock } = runtime.ports;

  /** The run's own credential is the only bearer that reads it, so a run id alone shows nothing. */
  async function ownRun(request: Request, id: string) {
    const secret = bearer(request);
    if (!secret) return { response: refusal("oidc.invalid", { message: "the credential that started the run is required" }) };
    const credential = await credentialBySecret({ d1 }, secret);
    const run = credential ? await runById(d1, id) : null;
    if (!credential || !run || run.credential_id !== credential.id) return { response: Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE }) };
    return { run };
  }

  app.get("/runs/:id", async (c) => {
    const own = await ownRun(c.req.raw, c.req.param("id"));
    if (!own.run) return own.response;
    return Response.json(runView(own.run, await milestonesOf(d1, own.run.id), clock.now()), { headers: NO_STORE });
  });

  app.post("/runs/:id/approve", () => Response.json({ error: "not-implemented", message: "staged approval is not available yet" }, { status: 501, headers: NO_STORE }));

  return app;
}
