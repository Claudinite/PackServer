import { Sha256 } from "@packserver/schema";
import { Hono } from "hono";
import { z } from "zod";
import { startRun } from "../admission/start";
import type { PublishRuntime } from "../bindings";
import { badRequest, bearer, readJson } from "../respond";
import { credentialBySecret } from "../upload/credentials";

const DryRunRequest = z.object({ sha256: Sha256, prose_screen: z.boolean().optional() });
const MAX_BODY_BYTES = 4 * 1024;

/**
 * `POST /api/dry-run`: validates the object a dry-run credential staged and creates no version.
 * Anyone without such a credential, the self-test caller included, is told the path does not exist.
 */
export function dryRunRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  const { d1 } = runtime.ports;

  app.post("/", async (c) => {
    const secret = bearer(c.req.raw);
    const credential = secret ? await credentialBySecret({ d1 }, secret) : null;
    if (!credential) return c.notFound();
    const body = await readJson(c.req.raw, MAX_BODY_BYTES);
    const parsed = body.ok ? DryRunRequest.safeParse(body.value) : null;
    if (!parsed?.success) return badRequest("expected { sha256, prose_screen? }");
    return startRun(runtime, { credential, kind: "dry-run", declaredSha256: parsed.data.sha256, proseScreen: parsed.data.prose_screen ?? false });
  });

  return app;
}
