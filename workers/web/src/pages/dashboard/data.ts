import { GITHUB_UNINSTALL_GRACE_MS, LAPSE_AFTER_MS } from "@packserver/core/scopes";
import type { Context } from "hono";
import type { WebEnv } from "../../context";

export type PackStatus = "live" | "working" | "needs-you";

export interface PackSummary {
  scope: string;
  name: string;
  visibility: "public" | "private";
  version: string | null;
  status: PackStatus;
  /** One line saying why a pack is not simply live. */
  why: string | null;
  stars: number;
  fetches: number;
  openIssues: number;
  /** The run in flight, when the pack is working. */
  run: string | null;
}

export type NeedKind = "approval" | "failed" | "rejected" | "proof" | "security" | "application";

export interface SheetView {
  new: string[];
  against: string | null;
  capabilities: { added: string[]; removed: string[] };
  files: Array<{ path: string; change: string; added_lines: number; removed_lines: number }>;
  filesTruncated: boolean;
}

export interface ApprovalOffer {
  runId: string;
  pack: string;
  version: string;
  reasons: string[];
  sheet: SheetView;
}

/** One thing blocked on the person; `href` is where the one action lives. */
export interface Need {
  kind: NeedKind;
  text: string;
  action: string | null;
  href: string | null;
  /** The sheet the owner reads before confirming with a passkey. */
  approval?: ApprovalOffer;
}

export interface Draft {
  pack: string;
  version: string;
  expired: boolean;
  href: string;
}

export interface Dashboard {
  packs: PackSummary[];
  needs: Need[];
  drafts: Draft[];
  /** Whether the person owns or maintains any scope with a pack, a draft or a run to show. */
  empty: boolean;
}

const DAY_MS = 86_400_000;
const mine = "(select scope_id from scope_members where user_id = ?)";
const owned = "(select scope_id from scope_members where user_id = ? and role = 'owner')";

export function sheetOf(raw: string): SheetView {
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* an unreadable sheet shows as empty */
  }
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : []);
  const caps = (v.capabilities ?? {}) as Record<string, unknown>;
  return {
    new: list(v.new),
    against: typeof v.against === "string" ? v.against : null,
    capabilities: { added: list(caps.added), removed: list(caps.removed) },
    files: Array.isArray(v.files) ? (v.files as SheetView["files"]).filter((f) => typeof f?.path === "string") : [],
    filesTruncated: v.files_truncated === true,
  };
}

export const REASON_TEXT: Record<string, string> = {
  widening: "adds new capabilities",
  "publisher-change": "the publisher changed",
  dormant: "the pack was dormant",
  "verified-publisher": "Verified Publisher approval",
  "declared-threshold": "widely declared",
};

const full = (scope: unknown, pack: unknown): string => `@${String(scope)}/${String(pack)}`;
const n = (v: unknown): number => Number(v ?? 0);

/** Everything the dashboard shows the person, read in one batch. */
export async function loadDashboard(c: Context<WebEnv>, userId: string): Promise<Dashboard> {
  const { d1, clock } = c.get("runtime").ports;
  const nowMs = clock.now();
  const now = new Date(nowMs).toISOString();

  const [packs, latestRuns, working, approvals, proofs, security, applications, issues, drafts, githubProofs] = await d1.batch([
    {
      sql: `select s.name as scope, p.id, p.name, p.visibility,
                   (select v.version from pack_versions v where v.pack_id = p.id and v.published_at is not null order by v.published_at desc, v.id desc limit 1) as version,
                   coalesce(st.stars, 0) as stars, coalesce(st.fetches_30d, 0) as fetches
              from packs p join scopes s on s.id = p.scope_id left join pack_stats st on st.pack_id = p.id
             where p.scope_id in ${mine} order by s.name, p.name`,
      params: [userId],
    },
    {
      sql: `select r.id, s.name as scope, r.pack_name, r.version, r.verdict, r.scope_id,
                   d.decision, d.reason as decision_reason, (select a.state from review_appeals a where a.run_id = r.id) as appeal
              from (select *, row_number() over (partition by scope_id, pack_name order by created_at desc, id desc) as n
                      from validation_runs where kind = 'publish' and synthetic = 0 and scope_id in ${mine}) r
              join scopes s on s.id = r.scope_id left join review_decisions d on d.run_id = r.id
             where r.n = 1 and r.status = 'finished'
               and ((r.verdict in ('fail', 'error')) or (r.verdict = 'hold' and d.decision is null) or (d.decision in ('reject', 'quarantine_publisher') and coalesce((select a.state from review_appeals a where a.run_id = r.id), '') != 'upheld'))`,
      params: [userId],
    },
    {
      sql: `select r.id, s.name as scope, r.pack_name, r.version from validation_runs r join scopes s on s.id = r.scope_id
             where r.kind = 'publish' and r.synthetic = 0 and r.status != 'finished' and r.scope_id in ${mine} order by r.created_at`,
      params: [userId],
    },
    {
      sql: `select r.id, s.name as scope, r.pack_name, r.version, a.reasons, a.sheet, c.released_at, c.object_expires_at
              from run_approvals a join validation_runs r on r.id = a.run_id join scopes s on s.id = r.scope_id
              left join upload_credentials c on c.id = r.credential_id
             where a.approved_at is null and r.scope_id in ${owned}`,
      params: [userId],
    },
    {
      sql: `select s.name as scope, c.domain, c.failed_since from domain_challenges c join scopes s on s.id = c.scope_id
             where c.state = 'proven' and c.failed_since is not null and c.scope_id in ${owned}`,
      params: [userId],
    },
    {
      sql: `select rp.id, rp.title, s.name as scope, p.name as pack from reports rp join packs p on p.id = rp.pack_id join scopes s on s.id = p.scope_id
             where rp.kind = 'security' and rp.status in ('open', 'acknowledged') and p.scope_id in ${mine} order by rp.created_at`,
      params: [userId],
    },
    {
      sql: `select s.name as scope from vp_applications a join scopes s on s.id = a.scope_id where a.state = 'pending' and a.scope_id in ${owned}`,
      params: [userId],
    },
    {
      sql: `select p.id, count(*) as open from reports rp join packs p on p.id = rp.pack_id
             where rp.kind = 'bug' and rp.status in ('open', 'acknowledged') and p.scope_id in ${mine} group by p.id`,
      params: [userId],
    },
    {
      sql: `select s.name as scope, u.pack_name, u.version, u.released_at, u.object_expires_at
              from upload_credentials u join scopes s on s.id = u.scope_id
             where u.user_id = ? and u.lifetime = 'draft' and u.uploaded_at is not null
               and not exists (select 1 from validation_runs r where r.credential_id = u.id)
             order by u.issued_at desc`,
      params: [userId],
    },
    {
      sql: `select s.name as scope, p.org_login,
                   (select i.status from github_installations i where i.account_id = cast(p.org_id as integer) order by (i.status = 'active') desc, i.installed_at desc, i.installation_id desc limit 1) as status,
                   (select coalesce(i.inactive_since, i.uninstalled_at) from github_installations i where i.account_id = cast(p.org_id as integer) order by (i.status = 'active') desc, i.installed_at desc, i.installation_id desc limit 1) as gone
              from github_org_proofs p join scopes s on s.id = p.scope_id where p.method = 'app' and p.scope_id in ${owned}`,
      params: [userId],
    },
  ]);

  const needs: Need[] = [];
  const reasons = new Map<string, string>();
  const drafted: Draft[] = [];
  const gone = (releasedAt: unknown, expiresAt: unknown): boolean => releasedAt !== null || (expiresAt !== null && String(expiresAt) <= now);

  for (const a of approvals!.rows) {
    const pack = full(a.scope, a.pack_name);
    if (gone(a.released_at, a.object_expires_at)) {
      drafted.push({ pack, version: String(a.version), expired: true, href: `/publish?pack=${encodeURIComponent(pack)}` });
      continue;
    }
    const why = (JSON.parse(String(a.reasons)) as string[]).map((r) => REASON_TEXT[r] ?? r).join(", ");
    reasons.set(pack, `${String(a.version)} awaiting approval`);
    const list = JSON.parse(String(a.reasons)) as string[];
    needs.push({
      kind: "approval",
      text: `${pack} ${String(a.version)} is awaiting your approval (${why}).`,
      action: "Review and approve",
      href: null,
      approval: { runId: String(a.id), pack, version: String(a.version), reasons: list, sheet: sheetOf(String(a.sheet)) },
    });
  }
  const review = new Map<string, string>();
  for (const r of latestRuns!.rows) {
    const pack = full(r.scope, r.pack_name);
    const version = String(r.version);
    const page = `/validation/${String(r.id)}`;
    const appealable = r.decision === "reject" || r.decision === "quarantine_publisher";
    const what = r.decision === "reject" ? "was rejected" : "was quarantined";
    if (appealable && r.appeal === null) {
      reasons.set(pack, `${version} ${what}`);
      needs.push({ kind: "rejected", text: `${pack} ${version} ${what} after review.`, action: "Appeal", href: page });
    } else if (appealable && r.appeal === "denied") {
      reasons.set(pack, `${version} ${what}`);
      needs.push({ kind: "rejected", text: `${pack} ${version} ${what} and the appeal was denied.`, action: r.decision === "reject" ? "Resubmit" : "See the report", href: page });
    } else if (r.decision !== null || r.verdict === "hold") {
      review.set(pack, `${version} under review`);
    } else {
      reasons.set(pack, `${version} failed validation`);
      needs.push({ kind: "failed", text: `${pack} ${version} failed validation.`, action: "See what to fix", href: page });
    }
  }
  for (const p of proofs!.rows) {
    const left = Math.max(0, Math.ceil((Date.parse(String(p.failed_since)) + LAPSE_AFTER_MS - nowMs) / DAY_MS));
    needs.push({ kind: "proof", text: `The proof of ${String(p.domain)} for @${String(p.scope)} fails its check and lapses in ${left} ${left === 1 ? "day" : "days"}.`, action: "Check now", href: `/orgs/${String(p.scope)}/settings#verification` });
  }
  for (const g of githubProofs!.rows) {
    if (g.status === "active" || g.gone === null || g.gone === undefined) continue;
    const left = Math.max(0, Math.ceil((Date.parse(String(g.gone)) + GITHUB_UNINSTALL_GRACE_MS - nowMs) / DAY_MS));
    needs.push({ kind: "proof", text: `The GitHub App is gone from ${String(g.org_login)}; the proof for @${String(g.scope)} lapses in ${left} ${left === 1 ? "day" : "days"}.`, action: "Check now", href: `/orgs/${String(g.scope)}/settings#verification` });
  }
  for (const s of security!.rows) {
    reasons.set(full(s.scope, s.pack), "a security report is open");
    needs.push({ kind: "security", text: `Security report on ${full(s.scope, s.pack)}: ${String(s.title)}.`, action: "Open", href: `/reports/${String(s.id)}` });
  }
  for (const a of applications!.rows) {
    needs.push({ kind: "application", text: `Verification pending for @${String(a.scope)}.`, action: "Details", href: `/orgs/${String(a.scope)}/settings#verification` });
  }
  for (const d of drafts!.rows) {
    drafted.push({ pack: full(d.scope, d.pack_name), version: String(d.version), expired: gone(d.released_at, d.object_expires_at), href: `/publish?pack=${encodeURIComponent(full(d.scope, d.pack_name))}` });
  }

  const busy = new Map(working!.rows.map((r) => [full(r.scope, r.pack_name), String(r.id)]));
  const open = new Map(issues!.rows.map((r) => [String(r.id), n(r.open)]));
  const summaries: PackSummary[] = packs!.rows.map((p) => {
    const name = full(p.scope, p.name);
    const needsYou = reasons.has(name);
    return {
      scope: String(p.scope),
      name: String(p.name),
      visibility: p.visibility === "private" ? "private" : "public",
      version: p.version === null ? null : String(p.version),
      status: needsYou ? "needs-you" : busy.has(name) || review.has(name) ? "working" : "live",
      why: reasons.get(name) ?? review.get(name) ?? (busy.has(name) ? "validating a new version" : null),
      stars: n(p.stars),
      fetches: n(p.fetches),
      openIssues: open.get(String(p.id)) ?? 0,
      run: busy.get(name) ?? null,
    };
  });
  const known = new Set(summaries.map((p) => `@${p.scope}/${p.name}`));
  for (const r of working!.rows) {
    const name = full(r.scope, r.pack_name);
    if (known.has(name)) continue;
    known.add(name);
    summaries.push({ scope: String(r.scope), name: String(r.pack_name), visibility: "public", version: null, status: reasons.has(name) ? "needs-you" : "working", why: reasons.get(name) ?? "validating the first version", stars: 0, fetches: 0, openIssues: 0, run: busy.get(name) ?? null });
  }
  for (const [name, why] of reasons) {
    if (known.has(name)) continue;
    known.add(name);
    const [scope, pack] = name.slice(1).split("/") as [string, string];
    summaries.push({ scope, name: pack, visibility: "public", version: null, status: "needs-you", why, stars: 0, fetches: 0, openIssues: 0, run: null });
  }
  for (const [name, why] of review) {
    if (known.has(name)) continue;
    known.add(name);
    const [scope, pack] = name.slice(1).split("/") as [string, string];
    summaries.push({ scope, name: pack, visibility: "public", version: null, status: "working", why, stars: 0, fetches: 0, openIssues: 0, run: null });
  }
  summaries.sort((a, b) => `${a.scope}/${a.name}`.localeCompare(`${b.scope}/${b.name}`));

  return { packs: summaries, needs, drafts: drafted, empty: summaries.length === 0 && drafted.length === 0 && needs.length === 0 };
}
