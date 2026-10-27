import type { D1 } from "@packserver/ports";

/** Where a job that works through a list in shares stopped: the last key it finished, or null when the next run starts from the top. */
export async function readCursor(d1: D1, key: string): Promise<string | null> {
  const { rows } = await d1.query("select value from community_state where key = ?", [key]);
  return rows[0] ? String(rows[0].value) : null;
}

/** Keeps `last` as the place to resume from, or forgets the place when the list has been worked through to its end. */
export async function writeCursor(d1: D1, key: string, last: string | null, at: string): Promise<void> {
  if (last === null) {
    await d1.query("delete from community_state where key = ?", [key]);
    return;
  }
  await d1.query(
    "insert into community_state (key, value, updated_at) values (?, ?, ?) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at",
    [key, last, at],
  );
}
