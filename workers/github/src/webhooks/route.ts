import { handleWebhook } from "@packserver/core/github";
import { refusal } from "@packserver/http";
import { syncClock } from "@packserver/ports";
import type { Context } from "hono";
import type { GithubRuntime } from "../bindings";
import { d1GithubStore } from "./d1-store";

/** GitHub caps a delivery at 25 MB; issue events with their bodies stay far under this. */
const MAX_DELIVERY_BYTES = 1024 * 1024;

/** Counts as it reads, so neither a missing nor a false `content-length` lets more than the cap into memory. */
export async function readCappedBody(request: Request, cap = MAX_DELIVERY_BYTES): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > cap) return null;
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A bad signature and an unknown installation get this same answer, so a prober learns nothing about which check failed. */
const ignored = () => refusal("signature");

export function webhookRoute(runtime: GithubRuntime) {
  return async (c: Context): Promise<Response> => {
    const body = await readCappedBody(c.req.raw);
    if (!body) return ignored();
    await syncClock(runtime.ports.clock);
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
