import type { Clock, D1, Rng } from "@packserver/ports";
import type { GitHubProfile } from "./github-login.ts";

export type LinkResult = { ok: true; created: boolean } | { ok: false; reason: "taken" };

/**
 * Adds a GitHub sign-in method to an account that asked for it from its own session. An identity that
 * belongs to another account is never moved or merged; nothing happens for an identity the account
 * already has.
 */
export async function linkGitHub(ports: { d1: D1; clock: Clock; rng: Rng }, userId: string, profile: GitHubProfile): Promise<LinkResult> {
  const held = await ports.d1.query("select user_id from identities where provider = 'github' and provider_user_id = ?", [profile.id]);
  const owner = held.rows[0]?.user_id;
  if (typeof owner === "string") return owner === userId ? { ok: true, created: false } : { ok: false, reason: "taken" };
  try {
    await ports.d1.query(
      "insert into identities (id, user_id, provider, provider_user_id, login, created_at) values (?, ?, 'github', ?, ?, ?)",
      [ports.rng.uuid(), userId, profile.id, profile.login, new Date(ports.clock.now()).toISOString()],
    );
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) return { ok: false, reason: "taken" };
    throw error;
  }
  return { ok: true, created: true };
}
