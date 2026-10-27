import type { D1 } from "@packserver/ports";
import { DOWNLOAD_RETENTION_MS } from "./constants.ts";
import { ownsDeclaringRepository } from "../github/scan.ts";

/**
 * Records that the person called `get_download` for the pack while signed in. The MCP tool that serves authenticated
 * downloads calls this once the download is granted; a repeat moves the time forward.
 */
export async function recordAuthenticatedDownload(d1: D1, input: { packId: string; userId: string; at: string }): Promise<void> {
  await d1.query(
    "insert into authenticated_downloads (pack_id, user_id, last_at) values (?, ?, ?) on conflict (pack_id, user_id) do update set last_at = excluded.last_at",
    [input.packId, input.userId, input.at],
  );
}

/** Forgets signed-in downloads older than the retention bound. Reviews keep the mark they earned. */
export async function pruneAuthenticatedDownloads(d1: D1, nowMs: number): Promise<void> {
  await d1.query("delete from authenticated_downloads where last_at < ?", [new Date(nowMs - DOWNLOAD_RETENTION_MS).toISOString()]);
}

/**
 * An account has a verified adoption of a pack when its linked GitHub identity owns a public repository the latest
 * completed weekly scan found declaring the pack, or when it called `get_download` for the pack signed in (REQ-COMM-006).
 */
export async function hasVerifiedAdoption(d1: D1, userId: string, pack: { id: string; name: string }): Promise<boolean> {
  const downloaded = await d1.query("select 1 from authenticated_downloads where pack_id = ? and user_id = ? limit 1", [pack.id, userId]);
  if (downloaded.rows.length > 0) return true;
  const { rows } = await d1.query("select login from identities where user_id = ? and provider = 'github' and login is not null", [userId]);
  for (const row of rows) if (await ownsDeclaringRepository(d1, String(row.login), pack.name)) return true;
  return false;
}
