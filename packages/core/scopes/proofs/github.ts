import type { ScopeRow } from "../access.ts";
import {
  announceProofChange, dateOf, GITHUB_UNINSTALL_GRACE_MS, isoOf, notifyOwners, settingsUrl, type ProofPorts,
} from "./context.ts";

export type GithubProofResult =
  | { ok: true; org: string; method: "app" | "admin" }
  | { ok: false; reason: "no_installation" | "installer_not_owner" | "not_org_admin" | "taken" | "has_org"; message: string };

const isUnique = (error: unknown): boolean => /UNIQUE/i.test(String(error));

/** A GitHub organisation login is case-insensitive, so it is compared and kept unique in lower case. */
const key = (login: string): string => login.trim().toLowerCase();

/** The login GitHub reports for an organisation the person is an admin of, as recorded at their last sign-in (REQ-SCOPE-008). */
async function adminLogin(ports: ProofPorts, userId: string, org: string): Promise<string | null> {
  const { rows } = await ports.d1.query("select github_org_login from github_org_admins where user_id = ? and lower(github_org_login) = ?", [userId, org]);
  return rows[0] ? String(rows[0].github_org_login) : null;
}

/**
 * Proves a GitHub organisation for the scope, by the PackServer GitHub App installed on it or by
 * the person's sign-in as one of its admins. An App installed by someone who is not an owner of
 * the organisation proves nothing.
 */
export async function proveGithubOrg(
  ports: ProofPorts,
  scope: ScopeRow,
  userId: string,
  input: { org: string; method: "app" | "admin" },
): Promise<GithubProofResult> {
  const org = key(input.org);
  const held = (await ports.d1.query("select org_login from github_org_proofs where scope_id = ?", [scope.id])).rows[0];
  if (held && String(held.org_login) !== org) return { ok: false, reason: "has_org", message: `${scope.name} already holds the proof of github.com/${String(held.org_login)}.` };

  let login: string;
  let installationId: number | null = null;
  if (input.method === "admin") {
    const found = await adminLogin(ports, userId, org);
    if (!found) return { ok: false, reason: "not_org_admin", message: `Sign in with GitHub as an owner of ${input.org} to prove it.` };
    login = found;
  } else {
    const install = (
      await ports.d1.query(
        `select installation_id, account_login, sender_login from github_installations
         where lower(account_login) = ? and account_type = 'Organization' and status = 'active' order by installed_at desc limit 1`,
        [org],
      )
    ).rows[0];
    if (!install) return { ok: false, reason: "no_installation", message: `The GitHub App is not installed on ${input.org}.` };
    const installerOwns = (
      await ports.d1.query(
        `select 1 as hit from identities i join github_org_admins a on a.user_id = i.user_id
         where i.provider = 'github' and lower(i.login) = lower(?) and lower(a.github_org_login) = ? limit 1`,
        [String(install.sender_login), org],
      )
    ).rows.length > 0;
    if (!installerOwns) {
      return { ok: false, reason: "installer_not_owner", message: `${String(install.sender_login)} installed the App but is not an owner of ${input.org}.` };
    }
    login = String(install.account_login);
    installationId = Number(install.installation_id);
  }

  const now = isoOf(ports.clock.now());
  try {
    await ports.d1.batch([
      {
        sql: `insert into github_org_proofs (scope_id, org_login, method, installation_id, proven_at, alerted_at) values (?, ?, ?, ?, ?, null)
              on conflict (scope_id) do update set method = excluded.method, installation_id = excluded.installation_id, alerted_at = null`,
        params: [scope.id, org, input.method, installationId, now],
      },
      { sql: "update scopes set verified_github_org = ? where id = ?", params: [login, scope.id] },
    ]);
  } catch (error) {
    if (isUnique(error)) return { ok: false, reason: "taken", message: `${input.org} is already proven by another scope.` };
    throw error;
  }
  await announceProofChange(ports, scope.name, "github_verified");
  return { ok: true, org: login, method: input.method };
}

export interface SweepSummary {
  alerted: number;
  revoked: number;
  restored: number;
}

/**
 * The App-based proofs follow the installation: the owners are alerted once it is gone, the proof
 * is removed 7 days after the uninstall, and a reinstall inside the grace clears the clock.
 */
export async function sweepGithubProofs(ports: ProofPorts): Promise<SweepSummary> {
  const nowMs = ports.clock.now();
  const now = isoOf(nowMs);
  const rows = (
    await ports.d1.query(
      `select p.scope_id, p.org_login, p.installation_id, p.alerted_at, s.name as scope_name, i.status, i.uninstalled_at
       from github_org_proofs p join scopes s on s.id = p.scope_id
       left join github_installations i on i.installation_id = p.installation_id
       where p.method = 'app' order by p.scope_id`,
    )
  ).rows as Array<{ scope_id: string; org_login: string; alerted_at: string | null; scope_name: string; status: string | null; uninstalled_at: string | null }>;

  const summary: SweepSummary = { alerted: 0, revoked: 0, restored: 0 };
  for (const row of rows) {
    if (row.status === "active") {
      if (row.alerted_at !== null) {
        await ports.d1.query("update github_org_proofs set alerted_at = null where scope_id = ?", [row.scope_id]);
        summary.restored++;
      }
      continue;
    }
    if (row.status !== "deleted" || row.uninstalled_at === null) continue;
    const endsMs = Date.parse(row.uninstalled_at) + GITHUB_UNINSTALL_GRACE_MS;
    if (nowMs >= endsMs) {
      await ports.d1.batch([
        { sql: "delete from github_org_proofs where scope_id = ? and method = 'app'", params: [row.scope_id] },
        { sql: "update scopes set verified_github_org = null where id = ?", params: [row.scope_id] },
      ]);
      await announceProofChange(ports, row.scope_name, "github_revoked");
      summary.revoked++;
      continue;
    }
    if (row.alerted_at === null) {
      await ports.d1.query("update github_org_proofs set alerted_at = ? where scope_id = ?", [now, row.scope_id]);
      await notifyOwners(ports, row.scope_id, "github-org-proof-alert", {
        scope: row.scope_name, org: row.org_login, removalDate: dateOf(endsMs), scopeUrl: settingsUrl(ports, row.scope_name),
      });
      summary.alerted++;
    }
  }
  return summary;
}

export interface GithubProofView {
  org: string;
  method: "app" | "admin";
  since: string;
  /** Set while the App is gone: the proof ends then unless it is installed again. */
  ends_at: string | null;
}

export async function githubProofOf(ports: Pick<ProofPorts, "d1">, scopeId: string): Promise<GithubProofView | null> {
  const row = (
    await ports.d1.query(
      `select s.verified_github_org as org, p.method, p.proven_at, i.status, i.uninstalled_at from github_org_proofs p
       join scopes s on s.id = p.scope_id left join github_installations i on i.installation_id = p.installation_id where p.scope_id = ?`,
      [scopeId],
    )
  ).rows[0];
  if (!row) return null;
  const gone = row.method === "app" && row.status === "deleted" && typeof row.uninstalled_at === "string";
  return {
    org: String(row.org),
    method: row.method as "app" | "admin",
    since: String(row.proven_at),
    ends_at: gone ? isoOf(Date.parse(String(row.uninstalled_at)) + GITHUB_UNINSTALL_GRACE_MS) : null,
  };
}
