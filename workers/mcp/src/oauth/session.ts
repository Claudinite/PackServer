import { hashSessionId, isSessionLive, loadSessionRecord, looksLikeSessionId, type LiveSession } from "@packserver/core/identity";
import { SESSION_COOKIE } from "@packserver/http";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { McpRuntime } from "../bindings";

/**
 * The web session of this browser, read and never touched: the consent page only needs to know who is
 * asking, and a session that was signed out or went idle is not one.
 */
export async function webSession(runtime: McpRuntime, c: Context): Promise<LiveSession | undefined> {
  const kv = runtime.ports.kv.SESSIONS_KV;
  if (!kv) throw new Error("the SESSIONS_KV binding is missing");
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid || !looksLikeSessionId(sid)) return undefined;
  const sid_hash = await hashSessionId(sid);
  if (!(await isSessionLive({ kv, d1: runtime.ports.d1, clock: runtime.tokenClock }, sid_hash))) return undefined;
  const record = await loadSessionRecord({ kv }, sid_hash);
  return record ? { sid, sid_hash, record } : undefined;
}
