export type HookSource = "monitors" | "issues" | "witness";

/** Each source speaks its own scheme with its own secret, so a signature valid for one source verifies for no other. */
export const WITNESS_TOLERANCE_MS = 5 * 60_000;

export type HookCheck = { ok: true } | { ok: false; reason: "missing" | "bad_signature" | "stale" | "unconfigured" };

const encoder = new TextEncoder();

async function hmac(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

export const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Compares two strings in time that does not depend on where they differ: both are digested under a throwaway key first. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const [x, y] = await Promise.all([hmac(salt, a), hmac(salt, b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

export interface HookRequest {
  header(name: string): string | undefined;
  body: string;
}

export async function signWitness(secret: string, body: string, nowMs: number): Promise<string> {
  return `t=${nowMs},v1=${hex(await hmac(secret, `${nowMs}.${body}`))}`;
}

export async function signGitHub(secret: string, body: string): Promise<string> {
  return `sha256=${hex(await hmac(secret, body))}`;
}

export async function verifyHook(source: HookSource, request: HookRequest, secret: string | undefined, nowMs: number): Promise<HookCheck> {
  if (!secret) return { ok: false, reason: "unconfigured" };
  switch (source) {
    case "monitors": {
      // Cloudflare Notifications send the secret itself in this header.
      const presented = request.header("cf-webhook-auth");
      if (!presented) return { ok: false, reason: "missing" };
      return (await safeEqual(presented, secret)) ? { ok: true } : { ok: false, reason: "bad_signature" };
    }
    case "issues": {
      const presented = request.header("x-hub-signature-256");
      if (!presented) return { ok: false, reason: "missing" };
      return (await safeEqual(presented, await signGitHub(secret, request.body))) ? { ok: true } : { ok: false, reason: "bad_signature" };
    }
    case "witness": {
      const presented = request.header("x-witness-signature");
      if (!presented) return { ok: false, reason: "missing" };
      const match = /^t=(\d{10,15}),v1=([0-9a-f]{64})$/.exec(presented);
      if (!match) return { ok: false, reason: "bad_signature" };
      const sentAt = Number(match[1]);
      const expected = await signWitness(secret, request.body, sentAt);
      if (!(await safeEqual(presented, expected))) return { ok: false, reason: "bad_signature" };
      return Math.abs(nowMs - sentAt) <= WITNESS_TOLERANCE_MS ? { ok: true } : { ok: false, reason: "stale" };
    }
  }
}
