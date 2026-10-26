import { chooseRegistration, type Registration } from "@packserver/core/publishing";
import { clientIp, rateLimit, refusal } from "@packserver/http";
import { PackName, PackVersion } from "@packserver/schema";
import { Hono } from "hono";
import { z } from "zod";
import type { PublishRuntime } from "../bindings";
import { badRequest, readJson, unavailable } from "../respond";
import { issueCredential, PublishingFrozen, TokenAlreadyUsed } from "../upload/credentials";
import { JwksUnavailable } from "./jwks";
import { verifyActionsToken } from "./verify";

const MAX_BODY_BYTES = 16 * 1024;

const ExchangeRequest = z.object({
  token: z.string().min(1),
  pack: PackName,
  version: PackVersion,
  /** `$GITHUB_JOB` of the job asking; GitHub's token does not carry it. */
  job: z.string().min(1).max(256).optional(),
});

interface RegistrationRow {
  id: string;
  scope_id: string;
  repository_id: string;
  repository_owner_id: string;
  workflow: string;
  environment: string | null;
  refs: string;
  events: string;
  pending_until: string | null;
}

const parseList = (text: string): string[] => {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

/** The one answer for a pack that has no usable registration, whether or not it exists. */
const noRegistration = () => refusal("forbidden", { message: "no trusted publisher is registered for this pack" });

export function oidcRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  const { d1, clock, kv } = runtime.ports;
  const cache = kv.CACHE_KV!;

  const limiter = runtime.ports.rateLimits.RATE_LIMIT;
  if (!limiter) throw new Error("the RATE_LIMIT binding is missing");

  app.post("/exchange", rateLimit({ limiter, key: (c) => `oidc-exchange:${clientIp(c)}` }), async (c) => {
    const body = await readJson(c.req.raw, MAX_BODY_BYTES);
    if (!body.ok) return badRequest(body.because === "too-large" ? "request too large" : "expected { token, pack, version, job }");
    const parsed = ExchangeRequest.safeParse(body.value);
    if (!parsed.success) return badRequest("expected { token, pack, version, job }");
    const { token, pack, version, job } = parsed.data;

    let verified;
    try {
      verified = await verifyActionsToken(token, { ...runtime.config.oidc, kv: cache, clock, fetch: runtime.config.fetch, url: runtime.config.oidc.jwksUrl });
    } catch (error) {
      if (error instanceof JwksUnavailable) {
        console.log(JSON.stringify({ event: "oidc.jwks_unavailable", detail: error.message }));
        return unavailable("the identity provider's keys could not be fetched", 30);
      }
      throw error;
    }
    if (!verified.ok) return refusal("oidc.invalid", { message: `token rejected: ${verified.because}` });
    const { claims } = verified;

    const [scopeName, packName] = pack.slice(1).split("/") as [string, string];
    const visibility = await d1.query(
      `select p.visibility from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?`,
      [scopeName, packName],
    );
    const isPrivate = visibility.rows[0]?.visibility === "private";

    const { rows } = await d1.query(
      `select tp.id, tp.scope_id, tp.repository_id, tp.repository_owner_id, tp.workflow, tp.environment, tp.refs, tp.events, tp.pending_until
       from trusted_publishers tp join scopes s on s.id = tp.scope_id where s.name = ? and tp.pack_name = ?`,
      [scopeName, packName],
    );
    const nowIso = new Date(clock.now()).toISOString();
    const live = (rows as unknown as RegistrationRow[]).filter((r) => r.pending_until === null || r.pending_until > nowIso);
    const registrations: Registration[] = live.map((r) => ({
      id: r.id,
      repository_id: r.repository_id,
      repository_owner_id: r.repository_owner_id,
      workflow: r.workflow,
      environment: r.environment,
      refs: parseList(r.refs),
      events: parseList(r.events),
    }));
    const chosen = chooseRegistration(claims, job ?? null, registrations);
    if (chosen === null) return noRegistration();
    if (!chosen.ok) {
      if (isPrivate) return noRegistration();
      return refusal(chosen.reason, { message: "the token does not match a trusted publisher registered for this pack", claim_diff: chosen.categories });
    }

    const existing = await d1.query(
      `select 1 from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id where s.name = ? and p.name = ? and v.version = ?`,
      [scopeName, packName, version],
    );
    if (existing.rows.length > 0) return refusal("exists", { message: `${pack}@${version} already exists` });

    const registration = live.find((r) => r.id === chosen.registration.id)!;
    let issued;
    try {
      issued = await issueCredential(runtime.ports, {
        source: "oidc",
        scope: { id: registration.scope_id, name: scopeName },
        packName,
        version,
        lifetime: "draft",
        trustedPublisherId: registration.id,
        claims: {
          repository: claims.repository,
          repository_id: claims.repository_id,
          repository_owner_id: claims.repository_owner_id,
          ref: claims.ref,
          sha: claims.sha,
          run_id: claims.run_id,
          event_name: claims.event_name,
          job_workflow_ref: claims.job_workflow_ref,
          environment: claims.environment ?? null,
          jti: claims.jti,
        },
        oidcJti: claims.jti,
      });
    } catch (error) {
      if (error instanceof TokenAlreadyUsed) return refusal("oidc.invalid", { message: "token already used" });
      if (error instanceof PublishingFrozen) return refusal("forbidden", { message: "publishing for this scope is paused while an account recovery is under review" });
      throw error;
    }
    return Response.json(
      {
        credential_id: issued.id,
        credential: issued.secret,
        expires_at: issued.expiresAt,
        pack,
        version,
        presign_path: `/api/publish/${pack}/${version}/upload-url`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  });

  return app;
}
