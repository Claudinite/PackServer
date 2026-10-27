import type { Context } from "hono";
import type { WebEnv } from "../../context";

export interface Registration {
  id: string;
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  workflow: string;
  environment: string | null;
  path: string;
  refs: string[];
  events: string[];
  pending_until: string | null;
}

export interface RunRow {
  id: string;
  version: string;
  kind: "publish" | "dry-run";
  status: "queued" | "running" | "finished";
  verdict: string | null;
  created_at: string;
}

export interface PackRow {
  name: string;
  /** A reservation for a pack that does not exist yet. */
  pending: boolean;
  visibility: "public" | "private" | null;
  trustedOnly: boolean;
  registrations: Registration[];
  runs: RunRow[];
}

export interface ScopeBlock {
  name: string;
  kind: "user" | "org";
  role: "owner" | "maintainer";
  packs: PackRow[];
}

const RUNS_PER_PACK = 5;
const RUN_WINDOW = 400;

const mine = "(select scope_id from scope_members where user_id = ?)";

/** Every scope the person owns or maintains, with its packs, their trusted publishers and the latest trusted-publishing runs. */
export async function loadGithub(c: Context<WebEnv>, userId: string): Promise<ScopeBlock[]> {
  const { d1, clock } = c.get("runtime").ports;
  const now = new Date(clock.now()).toISOString();
  const [scopes, packs, registrations, runs] = await d1.batch([
    { sql: `select s.id, s.name, s.kind, m.role from scope_members m join scopes s on s.id = m.scope_id where m.user_id = ? order by s.kind desc, s.name`, params: [userId] },
    {
      sql: `select p.scope_id, p.name, p.visibility, coalesce(ps.trusted_only, 0) as trusted_only
              from packs p left join pack_publish_settings ps on ps.scope_id = p.scope_id and ps.pack_name = p.name
             where p.scope_id in ${mine} order by p.name`,
      params: [userId],
    },
    {
      sql: `select id, scope_id, pack_name, repository, repository_id, repository_owner_id, workflow, environment, path, refs, events, pending_until
              from trusted_publishers where scope_id in ${mine} and (pending_until is null or pending_until > ?) order by created_at, id`,
      params: [userId, now],
    },
    {
      sql: `select id, scope_id, pack_name, version, kind, status, verdict, created_at from validation_runs
             where source = 'oidc' and synthetic = 0 and scope_id in ${mine} order by created_at desc, id desc limit ${RUN_WINDOW}`,
      params: [userId],
    },
  ]);

  const text = (v: unknown): string => String(v);
  const blocks = scopes!.rows.map((s) => ({ id: text(s.id), block: { name: text(s.name), kind: s.kind as "user" | "org", role: s.role as "owner" | "maintainer", packs: [] as PackRow[] } }));
  const find = (scopeId: string, name: string, make?: () => PackRow) => {
    const block = blocks.find((b) => b.id === scopeId);
    if (!block) return undefined;
    let pack = block.block.packs.find((p) => p.name === name);
    if (!pack && make) block.block.packs.push((pack = make()));
    return pack;
  };
  const empty = (name: string, pending: boolean): PackRow => ({ name, pending, visibility: null, trustedOnly: false, registrations: [], runs: [] });

  for (const p of packs!.rows) {
    const row = find(text(p.scope_id), text(p.name), () => empty(text(p.name), false));
    if (row) Object.assign(row, { visibility: p.visibility as "public" | "private", trustedOnly: Number(p.trusted_only) === 1 });
  }
  for (const r of registrations!.rows) {
    const row = find(text(r.scope_id), text(r.pack_name), () => empty(text(r.pack_name), true));
    row?.registrations.push({
      id: text(r.id), repository: text(r.repository), repository_id: text(r.repository_id), repository_owner_id: text(r.repository_owner_id),
      workflow: text(r.workflow), environment: r.environment === null ? null : text(r.environment), path: text(r.path),
      refs: JSON.parse(text(r.refs)) as string[], events: JSON.parse(text(r.events)) as string[],
      pending_until: r.pending_until === null ? null : text(r.pending_until),
    });
  }
  for (const r of runs!.rows) {
    const row = find(text(r.scope_id), text(r.pack_name));
    if (row && row.runs.length < RUNS_PER_PACK) {
      row.runs.push({ id: text(r.id), version: text(r.version), kind: r.kind as RunRow["kind"], status: r.status as RunRow["status"], verdict: r.verdict === null ? null : text(r.verdict), created_at: text(r.created_at) });
    }
  }
  for (const b of blocks) b.block.packs.sort((x, y) => x.name.localeCompare(y.name));
  return blocks.map((b) => b.block);
}
