import { readCursor, writeCursor } from "../../community/cursor.ts";
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

interface OrgRef {
  id: string;
  login: string;
}

/** The organisation the person is a recorded admin of (their last sign-in), found by login. */
async function adminOrgByLogin(ports: ProofPorts, userId: string, login: string): Promise<OrgRef | null> {
  const { rows } = await ports.d1.query("select github_org_id, github_org_login from github_org_admins where user_id = ? and lower(github_org_login) = ?", [userId, login]);
  return rows[0] ? { id: String(rows[0].github_org_id), login: String(rows[0].github_org_login) } : null;
}

async function isAdminOf(ports: ProofPorts, userId: string, orgId: string): Promise<boolean> {
  return (await ports.d1.query("select 1 as hit from github_org_admins where user_id = ? and github_org_id = ?", [userId, orgId])).rows.length > 0;
}

interface InstallationNow {
  installation_id: number;
  status: "active" | "suspended" | "deleted";
  /** When the App first stopped counting for the organisation: the suspension or the uninstall, whichever came first. */
  gone_at: string | null;
}

/** The organisation's current installation, found by its account id: a reinstall is a new installation id. */
async function installationOf(d1: ProofPorts["d1"], orgId: string): Promise<InstallationNow | null> {
  const row = (
    await d1.query(
      `select installation_id, status, inactive_since, uninstalled_at, updated_at from github_installations where account_id = ?
       order by (status = 'active') desc, installed_at desc, installation_id desc limit 1`,
      [Number(orgId)],
    )
  ).rows[0];
  if (!row) return null;
  const status = row.status as InstallationNow["status"];
  return {
    installation_id: Number(row.installation_id),
    status,
    gone_at: status === "active" ? null : String(row.inactive_since ?? row.uninstalled_at ?? row.updated_at),
  };
}

/**
 * Proves a GitHub organisation for the scope, by the PackServer GitHub App installed on it or by
 * the person's sign-in as one of its admins. Either way the caller must be a recorded admin of
 * the organisation, and an App installed by someone who is not an owner proves nothing.
 */
export async function proveGithubOrg(
  ports: ProofPorts,
  scope: ScopeRow,
  userId: string,
  input: { org: string; method: "app" | "admin" },
): Promise<GithubProofResult> {
  const typed = key(input.org);
  let org: OrgRef;
  let installationId: number | null = null;
  if (input.method === "admin") {
    const found = await adminOrgByLogin(ports, userId, typed);
    if (!found) return { ok: false, reason: "not_org_admin", message: `Sign in with GitHub as an owner of ${input.org} to prove it.` };
    org = found;
  } else {
    const install = (
      await ports.d1.query(
        `select installation_id, account_id, account_login, sender_login from github_installations
         where lower(account_login) = ? and account_type = 'Organization' and status = 'active' order by installed_at desc limit 1`,
        [typed],
      )
    ).rows[0];
    if (!install) return { ok: false, reason: "no_installation", message: `The GitHub App is not installed on ${input.org}.` };
    org = { id: String(install.account_id), login: String(install.account_login) };
    const installerOwns = (
      await ports.d1.query(
        `select 1 as hit from identities i join github_org_admins a on a.user_id = i.user_id
         where i.provider = 'github' and lower(i.login) = lower(?) and a.github_org_id = ? limit 1`,
        [String(install.sender_login), org.id],
      )
    ).rows.length > 0;
    if (!installerOwns) {
      return { ok: false, reason: "installer_not_owner", message: `${String(install.sender_login)} installed the App but is not an owner of ${input.org}.` };
    }
    if (!(await isAdminOf(ports, userId, org.id))) {
      return { ok: false, reason: "not_org_admin", message: `Only an owner of ${input.org} can prove it; sign in with GitHub as one.` };
    }
    installationId = Number(install.installation_id);
  }

  const held = (await ports.d1.query("select org_id, org_login from github_org_proofs where scope_id = ?", [scope.id])).rows[0];
  if (held && String(held.org_id) !== org.id) return { ok: false, reason: "has_org", message: `${scope.name} already holds the proof of github.com/${String(held.org_login)}.` };

  const now = isoOf(ports.clock.now());
  try {
    await ports.d1.batch([
      {
        sql: `insert into github_org_proofs (scope_id, org_id, org_login, method, installation_id, proven_at, alerted_at) values (?, ?, ?, ?, ?, ?, null)
              on conflict (scope_id) do update set method = excluded.method, installation_id = excluded.installation_id, org_login = excluded.org_login, alerted_at = null`,
        params: [scope.id, org.id, key(org.login), input.method, installationId, now],
      },
      { sql: "update scopes set verified_github_org = ? where id = ?", params: [org.login, scope.id] },
    ]);
  } catch (error) {
    if (isUnique(error)) return { ok: false, reason: "taken", message: `${input.org} is already proven by another scope.` };
    throw error;
  }
  await announceProofChange(ports, scope.name, "github_verified");
  return { ok: true, org: org.login, method: input.method };
}

export interface SweepSummary {
  alerted: number;
  revoked: number;
  restored: number;
}

/**
 * The App-based proofs follow the organisation's installation: the owners are alerted once the App
 * is gone or suspended, the proof is removed 7 days later, and an active installation inside the
 * grace, whatever its id, clears the clock. A run that has spent its share stops between two proofs and keeps where it
 * stopped, so the next run goes on from there and a list longer than one share is still reached whole.
 */
const SWEEP_CURSOR_KEY = "github_proof_lapse_cursor";
/** The most queries one proof can take (its installation, the repair or the revoke with its announcement, the alert with its mail) and the cursor write that follows. */
const QUERIES_PER_PROOF = 6;

export async function sweepGithubProofs(ports: ProofPorts, budget: { hasRoom?: (queries: number) => boolean } = {}): Promise<SweepSummary> {
  const nowMs = ports.clock.now();
  const now = isoOf(nowMs);
  const after = await readCursor(ports.d1, SWEEP_CURSOR_KEY);
  const rows = (
    await ports.d1.query(
      `select p.scope_id, p.org_id, p.org_login, p.installation_id, p.alerted_at, s.name as scope_name
       from github_org_proofs p join scopes s on s.id = p.scope_id where p.method = 'app' and p.scope_id > ? order by p.scope_id`,
      [after ?? ""],
    )
  ).rows as Array<{ scope_id: string; org_id: string; org_login: string; installation_id: number | null; alerted_at: string | null; scope_name: string }>;

  const summary: SweepSummary = { alerted: 0, revoked: 0, restored: 0 };
  let last: string | null = null;
  let stopped = false;
  for (const row of rows) {
    if (budget.hasRoom && !budget.hasRoom(QUERIES_PER_PROOF)) {
      stopped = true;
      break;
    }
    last = row.scope_id;
    const install = await installationOf(ports.d1, row.org_id);
    if (install?.status === "active") {
      if (row.alerted_at !== null || row.installation_id !== install.installation_id) {
        await ports.d1.query("update github_org_proofs set alerted_at = null, installation_id = ? where scope_id = ?", [install.installation_id, row.scope_id]);
        if (row.alerted_at !== null) summary.restored++;
      }
      continue;
    }
    if (!install || install.gone_at === null) continue;
    const endsMs = Date.parse(install.gone_at) + GITHUB_UNINSTALL_GRACE_MS;
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
        scope: row.scope_name, org: row.org_login, cause: install.status === "suspended" ? "suspended" : "removed", removalDate: dateOf(endsMs), scopeUrl: settingsUrl(ports, row.scope_name),
      });
      summary.alerted++;
    }
  }
  if (stopped) {
    if (last !== null) await writeCursor(ports.d1, SWEEP_CURSOR_KEY, last, now);
  } else if (after !== null) {
    await writeCursor(ports.d1, SWEEP_CURSOR_KEY, null, now);
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
      "select s.verified_github_org as org, p.org_id, p.method, p.proven_at from github_org_proofs p join scopes s on s.id = p.scope_id where p.scope_id = ?",
      [scopeId],
    )
  ).rows[0];
  if (!row) return null;
  const install = row.method === "app" ? await installationOf(ports.d1, String(row.org_id)) : null;
  const gone = install !== null && install.status !== "active" && install.gone_at !== null;
  return {
    org: String(row.org),
    method: row.method as "app" | "admin",
    since: String(row.proven_at),
    ends_at: gone ? isoOf(Date.parse(install.gone_at!) + GITHUB_UNINSTALL_GRACE_MS) : null,
  };
}
