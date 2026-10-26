import type { Cursor, ScanState, ScanStore } from "@packserver/core/github";
import type { D1 } from "@packserver/ports";

interface ScanRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  cursor: string | null;
  truncated: number;
}

const toState = (row: ScanRow): ScanState => ({
  id: row.id,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  cursor: row.cursor === null ? null : (JSON.parse(row.cursor) as Cursor),
  truncated: row.truncated === 1,
});

const FULL_NAME = "'@' || s.name || '/' || p.name";

export function d1ScanStore(d1: D1): ScanStore {
  return {
    async open() {
      const { rows } = await d1.query("select * from adoption_scans where completed_at is null order by started_at desc, id desc limit 1");
      return rows[0] ? toState(rows[0] as unknown as ScanRow) : null;
    },
    async lastCompletedAt() {
      const { rows } = await d1.query("select max(completed_at) as at from adoption_scans");
      return ((rows[0] as { at: string | null } | undefined)?.at) ?? null;
    },
    async begin(id, now) {
      await d1.query("insert into adoption_scans (id, started_at, updated_at) values (?, ?, ?)", [id, now, now]);
      return { id, startedAt: now, completedAt: null, cursor: null, truncated: false };
    },
    async packsAfter(after, limit) {
      const { rows } = await d1.query(
        `select ${FULL_NAME} as name from packs p join scopes s on s.id = p.scope_id
         where p.visibility = 'public' and s.kind != 'synthetic'
           and exists (select 1 from pack_versions v where v.pack_id = p.id and v.state != 'removed')
           and ${FULL_NAME} > ? order by name limit ?`,
        [after ?? "", limit],
      );
      return rows.map((r) => r.name as string);
    },
    async declare(scanId, declarations) {
      for (let at = 0; at < declarations.length; at += 40) {
        await d1.batch(
          declarations.slice(at, at + 40).map((d) => ({
            sql: "insert or ignore into pack_declarations (scan_id, pack, repository, owner, pinned_version, settings_path) values (?, ?, ?, ?, ?, ?)",
            params: [scanId, d.pack, d.repository, d.owner, d.pinnedVersion, d.settingsPath],
          })),
        );
      }
    },
    async save(scanId, progress) {
      await d1.query(
        "update adoption_scans set cursor = ?, rate_limit_remaining = coalesce(?, rate_limit_remaining), truncated = ?, updated_at = ? where id = ?",
        [JSON.stringify(progress.cursor), progress.rateRemaining, progress.truncated ? 1 : 0, progress.now, scanId],
      );
    },
    async complete(scanId, now, rateRemaining) {
      await d1.query("update adoption_scans set completed_at = ?, updated_at = ?, cursor = null, rate_limit_remaining = coalesce(?, rate_limit_remaining) where id = ?", [now, now, rateRemaining, scanId]);
      // The scan before this one stays: the dropped declarations are the difference between the two.
      await d1.batch([
        {
          sql: `delete from pack_declarations where scan_id in (
                  select id from adoption_scans where completed_at is not null
                  order by completed_at desc, id desc limit -1 offset 2)`,
        },
        { sql: "delete from adoption_scans where completed_at is not null and id not in (select id from adoption_scans where completed_at is not null order by completed_at desc, id desc limit 2)" },
      ]);
      const { rows } = await d1.query("select count(distinct repository) as repositories, count(distinct pack) as packs from pack_declarations where scan_id = ?", [scanId]);
      const row = rows[0] as { repositories: number; packs: number };
      return { repositories: Number(row.repositories), packs: Number(row.packs) };
    },
  };
}
