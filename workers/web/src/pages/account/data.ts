import { userActivity, type ActivityRow } from "@packserver/core/audit";
import {
  credentialsOf, listSessions, recoveryStatus, type CredentialRow, type RecoveryStatus, type SessionSummary,
} from "@packserver/core/identity";
import { listTokens, type TokenView } from "@packserver/core/tokens";
import { csrfTokenFor } from "@packserver/http";
import type { Context } from "hono";
import { sessionPorts, type WebEnv } from "../../context";

const HISTORY_LIMIT = 200;

export interface Who {
  userId: string;
  handle: string | null;
  identities: Array<{ provider: string; login: string }>;
  csrf: string;
}

export interface SecurityData extends Who {
  passkeys: CredentialRow[];
  recovery: RecoveryStatus;
  sessions: SessionSummary[];
  tokens: TokenView[];
  history: ActivityRow[];
  currentSession: string;
  now: number;
}

/** The signed-in person as the pages show them, or undefined when the account is gone. */
export async function loadWho(c: Context<WebEnv>): Promise<Who | undefined> {
  const live = c.get("session");
  if (!live) return undefined;
  const { d1 } = c.get("runtime").ports;
  const [user, identities] = await d1.batch([
    { sql: "select handle from users where id = ?", params: [live.record.user_id] },
    { sql: "select provider, login from identities where user_id = ? order by created_at", params: [live.record.user_id] },
  ]);
  const row = user!.rows[0];
  if (!row) return undefined;
  return {
    userId: live.record.user_id,
    handle: typeof row.handle === "string" ? row.handle : null,
    identities: identities!.rows.map((r) => ({ provider: String(r.provider), login: String(r.login) })),
    csrf: await csrfTokenFor(live),
  };
}

export async function loadSecurity(c: Context<WebEnv>, who: Who): Promise<SecurityData> {
  const runtime = c.get("runtime");
  const { d1, clock } = runtime.ports;
  const live = c.get("session")!;
  const [passkeys, recovery, sessions, tokens, history] = await Promise.all([
    credentialsOf(d1, who.userId),
    recoveryStatus(d1, who.userId),
    listSessions(sessionPorts(runtime), who.userId, live.sid_hash),
    listTokens({ d1, clock }, who.userId),
    userActivity(d1, who.userId, HISTORY_LIMIT),
  ]);
  return { ...who, passkeys, recovery, sessions, tokens, history, currentSession: live.sid_hash, now: clock.now() };
}
