// Usage: node tools/check-migrations.mjs [migrations-dir]
// Enforces docs/architecture/repo-layout.md and tasks.md §2.2 on packages/schema/migrations.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_MARKER, migrationFiles, renderRange } from "../packages/schema/scripts/gen-range.mjs";

const dir = process.argv[2] ?? join(import.meta.dirname, "../packages/schema/migrations");
const FOUNDATION = "foundation";
// The only tables another area's migration may reference.
const CROSS_AREA_TARGETS = ["users", "scopes", "packs", "pack_versions"];
const NAME = /^(\d{14})_([a-z][a-z0-9-]*)_([a-z0-9_]+)\.sql$/;
// Keywords the loose from/into/update patterns pick up, e.g. `AFTER UPDATE ON t`, `UPDATE OF c ON t`.
const SQL_WORDS = ["set", "select", "on", "of"];
const INTERNAL = /^(sqlite_|_cf_|d1_migrations$|__new_)/;
const problems = [];

const ident = "[`\"\\[]?(\\w+)";
const REFERENCE_PATTERNS = [
  new RegExp(`\\breferences\\s+${ident}`, "gi"),
  new RegExp(`\\balter\\s+table\\s+${ident}`, "gi"),
  new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?${ident}`, "gi"),
  new RegExp(`\\bcreate\\s+(?:unique\\s+)?index\\s+(?:if\\s+not\\s+exists\\s+)?\\S+\\s+on\\s+${ident}`, "gi"),
  new RegExp(`\\bcreate\\s+(?:temp\\w*\\s+)?trigger\\s[^;]*?\\bon\\s+${ident}`, "gi"),
  new RegExp(`\\b(?:from|join|into|update)\\s+${ident}`, "gi"),
];
const CREATED = new RegExp(`\\bcreate\\s+(?:virtual\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${ident}`, "gi");
const ALTERED = new RegExp(`\\balter\\s+table\\s+${ident}`, "gi");
const DROPPED = new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?${ident}`, "gi");
const RENAMED_TO = new RegExp(`\\brename\\s+to\\s+${ident}`, "gi");
const close = "[`\"\\]]?";
const REBUILD_RENAME = new RegExp(`^\\s*alter\\s+table\\s+${ident}${close}\\s+rename\\s+to\\s+${ident}${close}\\s*$`, "i");
const DROP_TABLE = new RegExp(`^\\s*drop\\s+table\\s+(?:if\\s+exists\\s+)?${ident}${close}\\s*$`, "i");
// Each of these breaks the previous Worker while it still serves against the new schema.
const UNSAFE = [
  [/\bdrop\s+table\b/i, "DROP TABLE"],
  [/\bdrop\s+column\b/i, "DROP COLUMN"],
  [/\brename\b/i, "RENAME"],
  [/\badd\s+(?:column\s+)?[^;]*\bnot\s+null\b/i, "ADD COLUMN NOT NULL without DEFAULT", (stmt) => !/\bdefault\b/i.test(stmt)],
];

function code(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\bon\s+(?:update|delete)\b/gi, " ")
    .replace(/\bdo\s+update\b/gi, " ");
}

const matches = (re, text) => [...text.matchAll(re)].map((m) => m[1].toLowerCase());

function snapshotColumns(file) {
  const path = join(dir, "meta", `${file.slice(0, 14)}_snapshot.json`);
  if (!existsSync(path)) return null;
  const tables = JSON.parse(readFileSync(path, "utf8")).tables ?? {};
  return Object.fromEntries(Object.entries(tables).map(([t, v]) => [t.toLowerCase(), Object.keys(v.columns ?? {})]));
}

/** Drizzle rebuilds a table (create __new_t, copy, drop t, rename) to change a column; that is safe unless a column goes. */
function rebuildStatements(sql, files, index) {
  const stmts = sql.split(";");
  const renames = stmts.map((s) => REBUILD_RENAME.exec(s)).filter((m) => m && /^__new_/i.test(m[1]));
  const rebuilt = new Set(renames.map((m) => m[2].toLowerCase()));
  const dropped = [];
  const before = index > 0 ? snapshotColumns(files[index - 1]) : {};
  const after = snapshotColumns(files[index]);
  for (const t of rebuilt) {
    if (!before || !after) dropped.push(`${t} (no snapshot to compare)`);
    else for (const c of before[t] ?? []) if (!(after[t] ?? []).includes(c)) dropped.push(`${t}.${c}`);
  }
  const rest = stmts.filter((s) => {
    const drop = DROP_TABLE.exec(s);
    if (drop && rebuilt.has(drop[1].toLowerCase())) return false;
    const rename = REBUILD_RENAME.exec(s);
    return !(rename && /^__new_/i.test(rename[1]));
  });
  return { rest, dropped, rebuilt };
}

/** A `__new_x` table is a rebuild only when this file renames it onto a table that already existed. */
function isRebuildOfExisting(table, sql) {
  const rename = sql.split(";").map((s) => REBUILD_RENAME.exec(s)).find((m) => m && m[1].toLowerCase() === table);
  return Boolean(rename) && table.startsWith("__new_") && created.has(rename[2].toLowerCase());
}

const files = migrationFiles(dir);
const seenPrefix = new Map();
const created = new Map(); // table -> area
const isContract = new Map();
const touched = new Map(); // file -> tables it creates or references
let firstFoundation = null;

files.forEach((file, index) => {
  const m = NAME.exec(file);
  if (!m) {
    problems.push(`${file}: name must be YYYYMMDDHHMMSS_<area>_<what>.sql`);
    return;
  }
  const [, prefix, area] = m;
  if (seenPrefix.has(prefix)) problems.push(`${file}: same timestamp prefix as ${seenPrefix.get(prefix)}`);
  else seenPrefix.set(prefix, file);

  const raw = readFileSync(join(dir, file), "utf8");
  const sql = code(raw);
  const own = new Set(matches(CREATED, sql));

  if (area === FOUNDATION) {
    firstFoundation ??= file;
    if (file !== firstFoundation && [...own].some((t) => !isRebuildOfExisting(t, sql)))
      problems.push(`${file}: only the first foundation migration (${firstFoundation}) may create foundation tables`);
  }

  const referenced = new Set();
  for (const re of REFERENCE_PATTERNS) for (const t of matches(re, sql)) referenced.add(t);
  for (const t of referenced) {
    if (own.has(t) || INTERNAL.test(t) || SQL_WORDS.includes(t)) continue;
    const owner = created.get(t);
    if (owner === undefined) problems.push(`${file}: references table ${t}, which no earlier migration created`);
    else if (owner !== area && !(owner === FOUNDATION && CROSS_AREA_TARGETS.includes(t)))
      problems.push(`${file}: references ${t} from area ${owner}; cross-area references point only at ${CROSS_AREA_TARGETS.join(", ")}`);
  }

  touched.set(file, new Set([...own, ...referenced]));
  for (const t of [...matches(ALTERED, sql), ...matches(DROPPED, sql)]) {
    if (area !== FOUNDATION && created.get(t) === FOUNDATION)
      problems.push(`${file}: changes foundation table ${t}; foundation tables are altered only by ${FOUNDATION} migrations`);
  }
  for (const t of own) if (!created.has(t)) created.set(t, area);
  for (const t of matches(RENAMED_TO, sql)) if (!created.has(t)) created.set(t, area);

  const { rest, dropped, rebuilt } = rebuildStatements(sql, files, index);
  const unsafe = dropped.map((c) => `DROP COLUMN ${c} (table rebuild)`);
  for (const [re, label, applies] of UNSAFE)
    if (rest.some((stmt) => re.test(stmt) && (applies?.(stmt) ?? true))) unsafe.push(label);

  const marker = CONTRACT_MARKER.exec(raw);
  isContract.set(file, Boolean(marker));
  if (unsafe.length > 0) {
    if (!marker) problems.push(`${file}: ${unsafe.join(", ")} breaks the running Worker; make it a contract migration with "-- contract-of: <earlier expand>.sql"`);
    else {
      const target = marker[1];
      if (!files.slice(0, index).includes(target)) problems.push(`${file}: contract-of ${target} is not an earlier migration`);
      else if (target === firstFoundation) problems.push(`${file}: contract-of ${target} creates the foundation tables, it is not an expand`);
      else if (isContract.get(target)) problems.push(`${file}: contract-of ${target} is itself a contract`);
      else {
        const changed = [...matches(ALTERED, sql), ...matches(DROPPED, sql), ...rebuilt].filter((t) => !INTERNAL.test(t));
        if (!changed.some((t) => touched.get(target)?.has(t)))
          problems.push(`${file}: contract-of ${target}, which did not touch ${[...new Set(changed)].join(", ")}`);
      }
    }
  } else if (marker) {
    problems.push(`${file}: marked contract-of but contains nothing a running Worker cannot survive`);
  }
});

if (files.length === 0) problems.push(`no migrations in ${dir}`);

const rangeFile = join(dir, "../src/range.ts");
if (files.length > 0 && existsSync(rangeFile) && readFileSync(rangeFile, "utf8") !== renderRange(dir))
  problems.push("src/range.ts is out of date; run pnpm --filter @packserver/schema gen:range");

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exitCode = 1;
} else {
  console.log(`check-migrations: ${files.length} migration(s) ok`);
}
