// Usage: node tools/check-migrations.mjs [migrations-dir]
// Enforces docs/architecture/repo-layout.md and tasks.md §2.2 on packages/schema/migrations.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_MARKER, CONTRACT_NAME, migrationFiles, renderRange } from "../packages/schema/scripts/gen-range.mjs";

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

const bare = (stmt) => stmt.replace(/[`"[\]]/g, "").trim();
const NAME_RE = "(\\w+)";
const STRICT_DROP = new RegExp(`^drop\\s+table\\s+${NAME_RE}$`, "i");
const STRICT_CREATE = new RegExp(`^create\\s+table\\s+${NAME_RE}\\b`, "i");
const COPY_INTO = new RegExp(`^insert\\s+(?:or\\s+\\w+\\s+)?into\\s+${NAME_RE}\\b[\\s\\S]*?\\bfrom\\s+${NAME_RE}\\b`, "i");
const CREATE_AS_COPY = new RegExp(`^create\\s+table\\s+${NAME_RE}\\s+as\\s+select\\b[\\s\\S]*?\\bfrom\\s+${NAME_RE}\\b`, "i");
const STRICT_RENAME = new RegExp(`^alter\\s+table\\s+${NAME_RE}\\s+rename\\s+to\\s+${NAME_RE}$`, "i");

/**
 * The rebuilds of an existing table that keep its rows, which are the only drops of one a migration may make.
 * Three shapes, each only when the whole sequence is there, in order:
 *  - Drizzle's: create __new_t, copy t into it, drop t, rename __new_t to t.
 *  - In place, for a parent other tables reference (deferred foreign keys need the rows inserted into a table
 *    of that name before the transaction ends): park t in a scratch table s (create ... as select from t, or
 *    create then insert ... from t), drop t, create t, insert into t from s, drop s.
 * `existing` are the tables so rebuilt, `scratch` the tables a rebuild creates and drops itself. `IF EXISTS`
 * variants are never part of a rebuild.
 */
function rowKeepingRebuilds(sql) {
  const stmts = sql.split(";").map(bare).filter(Boolean);
  const at = (test, from = 0) => stmts.findIndex((st, i) => i >= from && test(st));
  const existing = new Set();
  const scratch = new Set();
  stmts.forEach((stmt, i) => {
    const drop = STRICT_DROP.exec(stmt);
    if (!drop) return;
    const t = drop[1].toLowerCase();
    if (!created.has(t) || t.startsWith("__new_")) return;

    const renamed = at((st) => STRICT_RENAME.exec(st)?.[2].toLowerCase() === t, i + 1);
    if (renamed !== -1) {
      const from = STRICT_RENAME.exec(stmts[renamed])[1].toLowerCase();
      const made = at((st) => STRICT_CREATE.exec(st)?.[1].toLowerCase() === from);
      const copied = at((st) => COPY_INTO.exec(st)?.[1].toLowerCase() === from && COPY_INTO.exec(st)[2].toLowerCase() === t, made + 1);
      if (from.startsWith("__new_") && made !== -1 && made < i && copied !== -1 && copied < i) existing.add(t);
      return;
    }

    const recreated = at((st) => STRICT_CREATE.exec(st)?.[1].toLowerCase() === t && !/\bas\s+select\b/i.test(st), i + 1);
    if (recreated === -1) return;
    for (let k = 0; k < i; k++) {
      const asCopy = CREATE_AS_COPY.exec(stmts[k]);
      const plain = STRICT_CREATE.exec(stmts[k]);
      const s = (asCopy ? asCopy[1] : plain?.[1])?.toLowerCase();
      if (!s || s === t) continue;
      const parkedAt = asCopy ? (asCopy[2].toLowerCase() === t ? k : -1) : at((st) => COPY_INTO.exec(st)?.[1].toLowerCase() === s && COPY_INTO.exec(st)[2].toLowerCase() === t, k + 1);
      if (parkedAt === -1 || parkedAt >= i) continue;
      const refilled = at((st) => COPY_INTO.exec(st)?.[1].toLowerCase() === t && COPY_INTO.exec(st)[2].toLowerCase() === s, recreated + 1);
      const disturbed = refilled !== -1 && stmts.some((st, j) => j > k && j < refilled && (STRICT_DROP.exec(st)?.[1].toLowerCase() === s || STRICT_CREATE.exec(st)?.[1].toLowerCase() === s));
      const cleared = refilled === -1 || disturbed ? -1 : at((st) => STRICT_DROP.exec(st)?.[1].toLowerCase() === s, refilled + 1);
      if (cleared !== -1) {
        existing.add(t);
        scratch.add(s);
        return;
      }
    }
  });
  return { existing, scratch };
}

/** Drizzle rebuilds a table (create __new_t, copy, drop t, rename) to change a column; that is safe unless a column goes. */
function rebuildStatements(sql, files, index) {
  const stmts = sql.split(";");
  const kept = rowKeepingRebuilds(sql);
  const renames = stmts.map((s) => REBUILD_RENAME.exec(s)).filter((m) => m && /^__new_/i.test(m[1]) && kept.existing.has(m[2].toLowerCase()));
  const rebuilt = new Set([...renames.map((m) => m[2].toLowerCase()), ...kept.existing]);
  const dropped = [];
  const before = index > 0 ? snapshotColumns(files[index - 1]) : {};
  const after = snapshotColumns(files[index]);
  for (const t of rebuilt) {
    if (!before || !after) dropped.push(`${t} (no snapshot to compare)`);
    else for (const c of before[t] ?? []) if (!(after[t] ?? []).includes(c)) dropped.push(`${t}.${c}`);
  }
  const rest = stmts.filter((s) => {
    const drop = DROP_TABLE.exec(s);
    if (drop && STRICT_DROP.test(bare(s)) && (rebuilt.has(drop[1].toLowerCase()) || kept.scratch.has(drop[1].toLowerCase()))) return false;
    const rename = REBUILD_RENAME.exec(s);
    return !(rename && /^__new_/i.test(rename[1]) && rebuilt.has(rename[2].toLowerCase()));
  });
  return { rest, dropped, rebuilt };
}

/** A table this file rebuilds with its rows kept; only that is a rebuild of an existing table. */
function isRebuildOfExisting(table, sql) {
  const kept = rowKeepingRebuilds(sql);
  if (kept.existing.has(table)) return true;
  const rename = sql.split(";").map((s) => REBUILD_RENAME.exec(s)).find((m) => m && m[1].toLowerCase() === table);
  return Boolean(rename) && table.startsWith("__new_") && kept.existing.has(rename[2].toLowerCase());
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
  const inPlace = rowKeepingRebuilds(sql);
  const own = new Set(matches(CREATED, sql).filter((t) => !inPlace.scratch.has(t)));

  if (area === FOUNDATION) {
    firstFoundation ??= file;
    if (file !== firstFoundation && [...own].some((t) => !isRebuildOfExisting(t, sql)))
      problems.push(`${file}: only the first foundation migration (${firstFoundation}) may create foundation tables`);
  }

  const referenced = new Set();
  for (const re of REFERENCE_PATTERNS) for (const t of matches(re, sql)) referenced.add(t);
  for (const t of referenced) {
    if (own.has(t) || inPlace.scratch.has(t) || INTERNAL.test(t) || SQL_WORDS.includes(t)) continue;
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
  if (marker && !CONTRACT_NAME.test(file)) problems.push(`${file}: a contract migration carries "contract" as a word of its name (e.g. 20270101000000_search_contract_drop_old.sql), because a build that predates it judges the database by names alone`);
  if (!marker && CONTRACT_NAME.test(file)) problems.push(`${file}: named a contract but carries no "-- contract-of:" marker`);
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
