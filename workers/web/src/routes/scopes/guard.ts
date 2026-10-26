import { authorize, type Decision, type Need, type ScopePorts } from "@packserver/core/scopes";
import { idempotency, refusal, requireAssertion, requireSession, sessionCaller, sessionCsrf } from "@packserver/http";
import type { Context, MiddlewareHandler } from "hono";
import { mfaPorts, siteOriginOf, type WebEnv } from "../../context";

const NO_STORE = { "cache-control": "no-store" };

const chain =
  (...steps: MiddlewareHandler<WebEnv>[]): MiddlewareHandler<WebEnv> =>
  (c, next) =>
    // A step's Response travels up as its return value, which only the outermost step hands to Hono.
    steps.reduceRight<() => Promise<Response | void>>((following, step) => async () => step(c, following as () => Promise<void>), next)() as Promise<Response | void>;

/**
 * A form or JSON post that acts for the signed-in person, with the per-action assertion the action
 * claims. `target` names the object the request acts on, so an assertion made for one object works
 * on no other.
 */
export const sensitive = (action: string, target: (c: Context<WebEnv>) => string | Promise<string>): MiddlewareHandler<WebEnv> =>
  chain(
  requireSession<WebEnv>(),
  sessionCsrf<WebEnv>(siteOriginOf),
  requireAssertion<WebEnv>(action, { ports: (c) => mfaPorts(c.get("runtime")), target }),
  (c, next) => idempotency({ kv: c.get("runtime").ports.kv.SESSIONS_KV!, caller: sessionCaller })(c, next),
);

/** A change that is not sensitive: the person is signed in and the post comes from this site. */
export const signedInPost = (): MiddlewareHandler<WebEnv> =>
  chain(
  requireSession<WebEnv>(),
  sessionCsrf<WebEnv>(siteOriginOf),
  (c, next) => idempotency({ kv: c.get("runtime").ports.kv.SESSIONS_KV!, caller: sessionCaller })(c, next),
);

export const scopePorts = (c: Context<WebEnv>): ScopePorts => {
  const { d1, clock, rng } = c.get("runtime").ports;
  return { d1, clock, rng };
};

export const notFound = (): Response => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

export const ok = (c: Context<WebEnv>, body: object, status: 200 | 201 = 200): Response => c.json(body, status, NO_STORE);

/** The caller's standing on `scope`; a refusal comes back as the response to send. */
export async function standing(
  c: Context<WebEnv>,
  input: { scope: string; need: Need; resource: "public" | "private" },
): Promise<Extract<Decision, { kind: "allow" }> | Response> {
  const decision = await authorize(c.get("runtime").ports.d1, { ...input, userId: c.get("session")?.record.user_id });
  if (decision.kind === "allow") return decision;
  if (decision.kind === "not_found") return notFound();
  if (decision.kind === "mfa_required") {
    return refusal("mfa-required", { message: `@${decision.scope} requires everyone acting for it to have a passkey. Enrol one in Account > Security.` });
  }
  return refusal("forbidden", { message: input.need === "owner" ? "Only an owner can do this." : "Only the scope's owners and maintainers can do this." });
}
