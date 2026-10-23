import { handleWebhook } from "@packserver/core/github";
import { refusal } from "@packserver/http";
import type { Context } from "hono";
import type { GithubRuntime } from "../bindings";
import { d1GithubStore } from "./d1-store";

/** GitHub caps a delivery at 25 MB; issue events with their bodies stay far under this. */
const MAX_DELIVERY_BYTES = 1024 * 1024;

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_DELIVERY_BYTES) return null;
  const body = new Uint8Array(await request.arrayBuffer());
  return body.length > MAX_DELIVERY_BYTES ? null : body;
}

/** A bad signature and an unknown installation get this same answer, so a prober learns nothing about which check failed. */
const ignored = () => refusal("signature");

export function webhookRoute(runtime: GithubRuntime) {
  return async (c: Context): Promise<Response> => {
    const body = await readBody(c.req.raw);
    if (!body) return ignored();
    const [secret, appId] = await Promise.all([runtime.services.secrets.webhook(), runtime.services.secrets.appId()]);
    const outcome = await handleWebhook(
      {
        secret,
        appId,
        store: d1GithubStore(runtime.ports.d1),
        now: () => new Date(runtime.ports.clock.now()).toISOString(),
      },
      {
        event: c.req.header("x-github-event") ?? null,
        deliveryId: c.req.header("x-github-delivery") ?? null,
        signature: c.req.header("x-hub-signature-256") ?? null,
        body,
      },
    );
    if (outcome.result === "ignored") return ignored();
    if (outcome.result === "malformed") return c.json({ ok: false }, 400);
    return c.json({ ok: true, result: outcome.result });
  };
}
