export interface SchemaRange {
  min: string;
  max: string;
}

export type SchemaVerdict = { ok: true; head: string } | { ok: false; head: string | null; why: "unknown" | "below-min" | "contract-beyond-max" };

/** `20261026123929_reports_tables.sql` -> `20261026123929`. */
export function migrationStamp(name: string): string | null {
  const match = /^(\d{8,})_/.exec(name);
  return match ? match[1]! : null;
}

/**
 * A contract migration is named for it (`<stamp>_<area>_contract_<what>.sql`), because the
 * database keeps only names: an older build meeting a newer migration can read no more of it
 * than that. The migrations checker enforces the same shape on every file it admits.
 */
export function isContractMigration(name: string): boolean {
  return /^\d+_[a-z][a-z0-9-]*_(?:[a-z0-9_]*_)?contract(?:_[a-z0-9_]*)?\.sql$/.test(name);
}

/**
 * Within `min..max` is supported. Beyond `max` is a database one release ahead (an expand
 * applies before the code that uses it, and a rollback leaves it behind), which this build
 * serves only while everything past `max` is an expand.
 */
export function judgeSchemaHead(applied: readonly string[], range: SchemaRange): SchemaVerdict {
  const stamps = applied.flatMap((name) => {
    const stamp = migrationStamp(name);
    return stamp ? [{ name, stamp }] : [];
  });
  if (stamps.length === 0) return { ok: false, head: null, why: "unknown" };
  const head = stamps.reduce((newest, m) => (m.stamp > newest ? m.stamp : newest), "");
  if (head < range.min) return { ok: false, head, why: "below-min" };
  if (head <= range.max) return { ok: true, head };
  if (stamps.some((m) => m.stamp > range.max && isContractMigration(m.name))) return { ok: false, head, why: "contract-beyond-max" };
  return { ok: true, head };
}

/** The check name that carries the head and the range, which a closed detail enum cannot (REQ-OPS-011). */
export const schemaCheckName = (head: string | null, range: SchemaRange) => `d1.schema head=${head ?? "none"} range=${range.min}..${range.max}`;
