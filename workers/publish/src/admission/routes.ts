import { Sha256 } from "@packserver/schema";
import { refusal } from "@packserver/http";
import { Hono } from "hono";
import { z } from "zod";
import type { PublishRuntime } from "../bindings";
import { badRequest, bearer, readJson } from "../respond";
import { lookupCredential } from "../upload/credentials";
import { startRun } from "./start";

const StartRequest = z.object({ sha256: Sha256 });
const MAX_BODY_BYTES = 4 * 1024;

/** `POST /api/publish/@scope/name/<version>`: start validation of the object the credential staged, with the SHA-256 the publisher declares. */
export function startRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  const { d1, clock } = runtime.ports;

  app.post("/:scope{@[a-z0-9._-]+}/:name/:version", async (c) => {
    const secret = bearer(c.req.raw);
    if (!secret) return refusal("oidc.invalid", { message: "an upload credential is required" });
    const bound = { scope: c.req.param("scope").slice(1), packName: c.req.param("name"), version: c.req.param("version") };
    const found = await lookupCredential({ d1, clock }, secret, bound, { allowExpired: true });
    if (!found.ok) {
      return found.why === "wrong-pack"
        ? refusal("forbidden", { message: "this credential is bound to another pack or version" })
        : refusal("oidc.invalid", { message: "the credential is not recognised" });
    }
    const body = await readJson(c.req.raw, MAX_BODY_BYTES);
    const parsed = body.ok ? StartRequest.safeParse(body.value) : null;
    if (!parsed?.success) return badRequest("expected { sha256 }");
    return startRun(runtime, { credential: found.credential, kind: "publish", declaredSha256: parsed.data.sha256, proseScreen: false });
  });

  return app;
}
