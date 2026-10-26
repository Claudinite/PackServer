import {
  LIFETIME_METADATA_HEADER, MAX_UPLOAD_BYTES, STAGING_CONTENT_TYPE, STAGING_PREFIX_CAP_BYTES,
} from "@packserver/core/publishing";
import { refusal } from "@packserver/http";
import { Hono } from "hono";
import { z } from "zod";
import type { PublishRuntime } from "../bindings";
import { badRequest, bearer } from "../respond";
import { heldBytes, lookupCredential, spendCredential, type CredentialRow } from "./credentials";

const PresignRequest = z.object({ content_length: z.number().int().positive() });

const MiB = 1024 * 1024;

type Bound = { scope: string; packName: string; version: string };
type Authorised = { ok: true; credential: CredentialRow } | { ok: false; response: Response };

export function uploadRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  const { d1, clock, r2 } = runtime.ports;
  const staging = r2.PACKS_STAGING!;

  async function authorise(request: Request, bound: Bound, options: { allowExpired?: boolean } = {}): Promise<Authorised> {
    const secret = bearer(request);
    if (!secret) return { ok: false, response: refusal("oidc.invalid", { message: "an upload credential is required" }) };
    const found = await lookupCredential({ d1, clock }, secret, bound, options);
    if (found.ok) return found;
    if (found.why === "wrong-pack") return { ok: false, response: refusal("forbidden", { message: "this credential is bound to another pack or version" }) };
    return { ok: false, response: refusal("oidc.invalid", { message: found.why === "expired" ? "the credential has expired" : "the credential is not recognised" }) };
  }

  const boundOf = (c: { req: { param(name: string): string } }): Bound => ({ scope: c.req.param("scope").replace(/^@/, ""), packName: c.req.param("name"), version: c.req.param("version") });

  app.post("/:scope/:name/:version/upload-url", async (c) => {
    const bound = boundOf(c);
    const auth = await authorise(c.req.raw, bound);
    if (!auth.ok) return auth.response;
    const { credential } = auth;
    if (credential.used_at !== null) return refusal("oidc.invalid", { message: "the credential has already been used" });

    const parsed = PresignRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest("expected { content_length }");
    const bytes = parsed.data.content_length;
    if (bytes > MAX_UPLOAD_BYTES) return refusal("quota", { status: 413, message: `an archive is at most ${MAX_UPLOAD_BYTES / MiB} MiB` });

    const spent = await spendCredential({ d1, clock }, credential, bytes, STAGING_PREFIX_CAP_BYTES);
    if (spent === "used") return refusal("oidc.invalid", { message: "the credential has already been used" });
    if (spent === "over-cap") {
      const held = await heldBytes({ d1, clock }, credential.scope_id);
      return refusal("quota", { message: `staging holds ${Math.ceil(held / MiB)} of ${STAGING_PREFIX_CAP_BYTES / MiB} MiB; free space or wait for drafts to expire` });
    }

    const now = clock.now();
    const presigned = await runtime.config.presigner.presignPut({
      key: credential.staging_key,
      contentLength: bytes,
      contentType: STAGING_CONTENT_TYPE,
      metadata: { [LIFETIME_METADATA_HEADER]: credential.lifetime },
      nowMs: now,
      expiresInSeconds: Math.max(1, Math.floor((Date.parse(credential.expires_at) - now) / 1000)),
    });
    return Response.json(
      { method: "PUT", url: presigned.url, headers: presigned.headers, key: credential.staging_key, credential_id: credential.id, expires_at: credential.expires_at },
      { headers: { "cache-control": "no-store" } },
    );
  });

  /** The client's own word that the PUT finished; the object is measured here, not trusted. Accepted after the credential expires, so a late confirmation is still counted. */
  app.post("/:scope/:name/:version/uploaded", async (c) => {
    const auth = await authorise(c.req.raw, boundOf(c), { allowExpired: true });
    if (!auth.ok) return auth.response;
    const { credential } = auth;
    if (credential.used_at === null) return refusal("oidc.invalid", { message: "no upload URL was issued for this credential" });

    const head = await staging.head(credential.staging_key);
    if (!head) return new Response(JSON.stringify({ error: "missing", message: "no object has been uploaded" }), { status: 409, headers: { "content-type": "application/json" } });
    if (head.size > MAX_UPLOAD_BYTES) {
      await staging.delete(credential.staging_key);
      await d1.query(`update upload_credentials set released_at = ? where id = ?`, [new Date(clock.now()).toISOString(), credential.id]);
      return refusal("quota", { status: 413, message: `the object was over ${MAX_UPLOAD_BYTES / MiB} MiB and has been deleted` });
    }
    await d1.query(`update upload_credentials set uploaded_at = ?, size_bytes = ? where id = ? and uploaded_at is null`, [new Date(clock.now()).toISOString(), head.size, credential.id]);
    return Response.json({ key: credential.staging_key, size_bytes: head.size }, { headers: { "cache-control": "no-store" } });
  });

  return app;
}
