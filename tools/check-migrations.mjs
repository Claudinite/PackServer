// Usage: node tools/check-migrations.mjs [migrations-dir]
// Enforces docs/architecture/repo-layout.md and tasks.md §2.2 on packages/schema/migrations.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_MARKER, migrationFiles, renderRange } from "../packages/schema/scripts/gen-range.mjs";

const dir = process.argv[2] ?? join(import.meta.dirname, "../packages/schema/migrations");
const FOUNDATION = "foundation";
const NAME = /^(\d{14})_([a-z][a-z0-9-]*)_([a-z0-9_]+)\.sql$/;
const INTERNAL = /^(sqlite_|_cf_|d1_migrations$|__new_)/;
const problems = [];

const ident = "[`\"\\[]?(\\w+)";
const REFERENCE_PATTERNS = [
  new RegExp(`\\breferences\\s+${ident}`, "gi"),
  new RegExp(`\\balter\\s+table\\s+${ident}`, "gi"),
  new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?${ident}`, "gi"),
  new RegExp(`\\bcreate\\s+(?:unique\\s+)?index\\s+(?:if\\s+not\\s+exists\\s+)?\\S+\\s+on\\s+${ident}`, "gi"),
  new RegExp(`\\b(?:from|join|into|update)\\s+${ident}`, "gi"),
];
const CREATED = new RegExp(`\\bcreate\\s+(?:virtual\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${ident}`, "gi");
const RENAMED_TO = new RegExp(`\\brename\\s+to\\s+${ident}`, "gi");
// Each of these breaks the previous Worker while it still serves against the new schema.
const UNSAFE = [
  [/\bdrop\s+table\b/i, "DROP TABLE"],
  [/\bdrop\s+column\b/i, "DROP COLUMN"],
  [/\brename\b/i, "RENAME"],
  [/\badd\s+(?:column\s+)?[^;]*\bnot\s+null\b(?![^;,]*\bdefault\b)/i, "ADD COLUMN NOT NULL without DEFAULT"],
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

const files = migrationFiles(dir);
const seenPrefix = new Map();
const created = new Map(); // table -> area

for (const file of files) {
  const m = NAME.exec(file);
  if (!m) {
    problems.push(`${file}: name must be YYYYMMDDHHMMSS_<area>_<what>.sql`);
    continue;
  }
  const [, prefix, area] = m;
  if (seenPrefix.has(prefix)) problems.push(`${file}: same timestamp prefix as ${seenPrefix.get(prefix)}`);
  else seenPrefix.set(prefix, file);

  const raw = readFileSync(join(dir, file), "utf8");
  const sql = code(raw);
  const own = new Set(matches(CREATED, sql));

  const referenced = new Set();
  for (const re of REFERENCE_PATTERNS) for (const t of matches(re, sql)) referenced.add(t);
  for (const t of referenced) {
    if (own.has(t) || INTERNAL.test(t) || t === "set" || t === "select") continue;
    const owner = created.get(t);
    if (owner === undefined) problems.push(`${file}: references table ${t}, which no earlier migration created`);
    else if (owner !== FOUNDATION && owner !== area)
      problems.push(`${file}: references ${t} from area ${owner}; cross-area references point at foundation tables only`);
  }

  for (const t of [...own, ...matches(RENAMED_TO, sql)]) if (!created.has(t)) created.set(t, area);

  const unsafe = UNSAFE.filter(([re]) => re.test(sql)).map(([, label]) => label);
  if (unsafe.length > 0) {
    const marker = CONTRACT_MARKER.exec(raw);
    if (!marker) problems.push(`${file}: ${unsafe.join(", ")} breaks the running Worker; make it a contract migration with "-- contract-of: <earlier expand>.sql"`);
    else if (!files.slice(0, files.indexOf(file)).includes(marker[1]))
      problems.push(`${file}: contract-of ${marker[1]} is not an earlier migration`);
  } else if (CONTRACT_MARKER.test(raw)) {
    problems.push(`${file}: marked contract-of but contains nothing a running Worker cannot survive`);
  }
}

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
