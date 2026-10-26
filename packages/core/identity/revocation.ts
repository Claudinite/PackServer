import { destroySession, listSessions, loadSessionRecord, type SessionPorts } from "./sessions.ts";

/** Ends one of the person's own sessions; another person's id, or one already gone, is not found. */
export async function revokeSession(
  ports: SessionPorts, userId: string, sidHash: string, beforeRevoke: () => Promise<void> = async () => {},
): Promise<boolean> {
  const record = await loadSessionRecord(ports, sidHash);
  if (record === null || record.user_id !== userId) return false;
  await beforeRevoke();
  await destroySession(ports, { sid_hash: sidHash, record });
  return true;
}

/** Ends every session of the person except the one named, if any. Returns how many it ended. */
export async function revokeSessionsOf(ports: SessionPorts, userId: string, except?: string): Promise<number> {
  let ended = 0;
  for (const session of await listSessions(ports, userId)) {
    if (session.id !== except && (await revokeSession(ports, userId, session.id))) ended++;
  }
  return ended;
}
