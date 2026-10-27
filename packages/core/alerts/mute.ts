import { hex, safeEqual } from "./hook-signature";
import { isPageId, type PageId } from "./catalogue";

/** A mute silences one page for this long from the moment the alert was raised, and the link stops working then too. */
export const MUTE_DURATION_MS = 4 * 3_600_000;

const encoder = new TextEncoder();

async function sign(key: string, page: string, until: number): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(`mute|${page}|${until}`))));
}

export async function muteQuery(key: string, page: PageId, raisedAtMs: number): Promise<string> {
  const until = raisedAtMs + MUTE_DURATION_MS;
  return `page=${encodeURIComponent(page)}&until=${until}&sig=${await sign(key, page, until)}`;
}

export type MuteCheck = { ok: true; page: PageId; until: number } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifyMute(key: string, params: { page?: string | null; until?: string | null; sig?: string | null }, nowMs: number): Promise<MuteCheck> {
  const until = Number(params.until);
  if (!isPageId(params.page) || !Number.isSafeInteger(until) || !params.sig || !/^[0-9a-f]{64}$/.test(params.sig)) return { ok: false, reason: "malformed" };
  if (!(await safeEqual(params.sig, await sign(key, params.page, until)))) return { ok: false, reason: "bad_signature" };
  return until > nowMs ? { ok: true, page: params.page, until } : { ok: false, reason: "expired" };
}
