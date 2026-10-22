#!/usr/bin/env node
// Regenerates coverage.md from the test specs in this folder and the requirement register, and
// prints the burndown line. Run from anywhere:
//
//   node docs/testing/coverage.mjs             # rewrite coverage.md, print counts, exit 1 on a gap
//   node docs/testing/coverage.mjs --check     # verify coverage.md is current, write nothing
//   node docs/testing/coverage.mjs --junit reports/scenarios.xml   # also count passing tests
//
// The register is the list of ids; a test covers an id when its `- **Covers:**` line names it; a
// requirement with no test must be excused in a page's "Not covered by an integration test" list.
// Status (pass/fail) never lives in the repo: it comes from a JUnit file at run time.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const requirementsDir = join(here, '..', 'requirements');
const args = process.argv.slice(2);
const check = args.includes('--check');
const junitPath = args.includes('--junit') ? args[args.indexOf('--junit') + 1] : null;

const ID = /REQ-[A-Z]+-\d{3}/g;

// --- the register ---------------------------------------------------------------------------
const requirements = new Map(); // id -> { title, status, coverage, page }
for (const file of readdirSync(requirementsDir).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
  const lines = readFileSync(join(requirementsDir, file), 'utf8').split('\n');
  let current = null;
  for (const line of lines) {
    const h = line.match(/^## (REQ-[A-Z]+-\d{3}) (.*)$/);
    if (h) {
      current = { id: h[1], title: h[2].trim(), status: null, coverage: null, page: file };
      requirements.set(h[1], current);
      continue;
    }
    if (!current) continue;
    const s = line.match(/^- status: (\w+)/);
    if (s) current.status = s[1];
    const c = line.match(/^- coverage: (.*)$/);
    if (c) current.coverage = c[1].trim();
  }
}
const live = [...requirements.values()].filter((r) => r.status === 'active' || r.status === 'provisional');
const retired = [...requirements.values()].filter((r) => r.status === 'retired');

// --- the test specs -------------------------------------------------------------------------
const tests = []; // { id, title, covers, runs, phase, page }
const excuses = new Map(); // req id -> { kind, reason, page }
const areaPages = readdirSync(here)
  .filter((f) => f.endsWith('.md') && !['README.md', 'coverage.md'].includes(f))
  .sort();
for (const file of areaPages) {
  const lines = readFileSync(join(here, file), 'utf8').split('\n');
  let current = null;
  let inExcuses = false;
  for (const line of lines) {
    const h = line.match(/^### ((?:IT-[A-Z]+|JT)-\d{3}) (.*)$/);
    if (h) {
      current = { id: h[1], title: h[2].trim(), covers: [], runs: '', phase: null, page: file };
      tests.push(current);
      inExcuses = false;
      continue;
    }
    if (/^## Not covered by an integration test/.test(line)) {
      inExcuses = true;
      current = null;
      continue;
    }
    if (/^## /.test(line)) inExcuses = false;
    if (inExcuses) {
      const e = line.match(/^- \*\*(REQ-[A-Z]+-\d{3})\*\* — (\w[\w-]*):? ?(.*)$/);
      if (e) excuses.set(e[1], { kind: e[2], reason: e[3].trim(), page: file });
      continue;
    }
    if (!current) continue;
    const c = line.match(/^- \*\*Covers:\*\* (.*)$/);
    if (c) current.covers = c[1].match(ID) ?? [];
    const r = line.match(/^- \*\*Runs:\*\* (.*)$/);
    if (r) current.runs = r[1].trim();
    const p = line.match(/^- \*\*Phase:\*\* (.*)$/);
    if (p) current.phase = p[1].trim();
  }
}

// --- joins and checks -----------------------------------------------------------------------
const byReq = new Map();
for (const t of tests) for (const id of t.covers) (byReq.get(id) ?? byReq.set(id, []).get(id)).push(t.id);

const problems = [];
const dupTests = tests.map((t) => t.id).filter((id, i, a) => a.indexOf(id) !== i);
for (const d of dupTests) problems.push(`duplicate test id ${d}`);
for (const t of tests) for (const id of t.covers) {
  const r = requirements.get(id);
  if (!r) problems.push(`${t.id} names unknown id ${id}`);
  else if (r.status === 'retired') problems.push(`${t.id} names retired id ${id}`);
}
for (const id of excuses.keys()) if (!requirements.has(id)) problems.push(`excuse names unknown id ${id}`);
for (const r of live) {
  const covered = byReq.has(r.id);
  const excused = excuses.has(r.id);
  if (!covered && !excused) problems.push(`${r.id} has no integration test and no excuse`);
  if (covered && excused && !/^covered/.test(excuses.get(r.id).kind)) problems.push(`${r.id} is both covered and excused as ${excuses.get(r.id).kind}`);
}

// --- burndown -------------------------------------------------------------------------------
const v1Tests = tests.filter((t) => !t.phase);
const laterTests = tests.filter((t) => t.phase);
const journeys = tests.filter((t) => t.id.startsWith('JT-'));
let passing = null;
if (junitPath) {
  const xml = readFileSync(junitPath, 'utf8');
  const passed = new Set();
  for (const m of xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = m[1];
    const body = m[3] ?? '';
    if (/<(failure|error|skipped)\b/.test(body)) continue;
    for (const id of name.match(/\b(?:IT-[A-Z]+|JT)-\d{3}\b/g) ?? []) passed.add(id);
  }
  passing = v1Tests.filter((t) => passed.has(t.id)).length;
}

// --- coverage.md ----------------------------------------------------------------------------
const areaOf = (id) => id.split('-')[1];
const order = ['ACC', 'SCOPE', 'PUB', 'VAL', 'SCORE', 'PRIV', 'PAY', 'COMM', 'MOD', 'ABUSE', 'SEARCH', 'TELEM', 'DELIV', 'CN', 'ADMIN', 'AUDIT', 'OPS'];
const sorted = [...live].sort((a, b) => order.indexOf(areaOf(a.id)) - order.indexOf(areaOf(b.id)) || a.id.localeCompare(b.id));

const perPage = new Map();
for (const t of tests) perPage.set(t.page, (perPage.get(t.page) ?? 0) + 1);

const coveredCount = live.filter((r) => byReq.has(r.id)).length;
const excusedOnly = live.filter((r) => !byReq.has(r.id) && excuses.has(r.id));
const byKind = new Map();
for (const r of excusedOnly) {
  const k = excuses.get(r.id).kind;
  byKind.set(k, (byKind.get(k) ?? 0) + 1);
}

let md = '';
md += '# Requirement coverage\n\n';
md += 'Generated by `node docs/testing/coverage.mjs` from the test specs in this folder and the register in\n';
md += '`docs/requirements/`; do not edit by hand. A row lists every integration test whose `Covers` line\n';
md += 'names the id; a requirement without one carries the reason from its page\'s "Not covered by an\n';
md += 'integration test" list. Pass/fail status is never recorded here (see [README.md](README.md)).\n\n';
md += '## Totals\n\n';
md += `- Register: ${live.length} live ids (${live.filter((r) => r.status === 'active').length} active, ${live.filter((r) => r.status === 'provisional').length} provisional), ${retired.length} retired.\n`;
md += `- Covered by at least one integration test: ${coveredCount} of ${live.length}.\n`;
md += `- Not covered by an integration test: ${excusedOnly.length}` + (excusedOnly.length ? ` (${[...byKind].map(([k, n]) => `${k}: ${n}`).join(', ')})` : '') + '.\n';
md += `- Tests specified: ${tests.length} (${v1Tests.length} in the v1 burndown, ${laterTests.length} later-phase; ${journeys.length} journeys).\n`;
md += '- Tests per page: ' + [...perPage].map(([p, n]) => `${basename(p, '.md')} ${n}`).join(', ') + '.\n\n';
md += '## REQ id → tests\n\n';
md += '| REQ id | Status | Title | Integration tests | If none, why |\n|---|---|---|---|---|\n';
for (const r of sorted) {
  const ts = byReq.get(r.id) ?? [];
  const ex = excuses.get(r.id);
  const links = ts.map((t) => {
    const page = tests.find((x) => x.id === t).page;
    return `[${t}](${page}#${t.toLowerCase()})`;
  }).join(', ');
  const why = ts.length ? (ex ? `${ex.kind}: ${ex.reason}` : '') : ex ? `**${ex.kind}** — ${ex.reason}` : '**UNCOVERED**';
  md += `| ${r.id} | ${r.status} | ${r.title.replace(/\|/g, '\\|')} | ${links} | ${why.replace(/\|/g, '\\|')} |\n`;
}
md += '\n## Retired ids\n\nNo test may name these.\n\n';
md += retired.map((r) => `- ${r.id} ${r.title}`).join('\n') + '\n';
md += '\n## Tests with no live requirement\n\n';
const orphan = tests.filter((t) => t.covers.length === 0);
md += orphan.length ? orphan.map((t) => `- ${t.id}`).join('\n') + '\n' : '(none)\n';

const target = join(here, 'coverage.md');
if (check) {
  let existing = '';
  try { existing = readFileSync(target, 'utf8'); } catch { /* missing counts as stale */ }
  if (existing !== md) problems.push('coverage.md is stale; run node docs/testing/coverage.mjs');
} else {
  writeFileSync(target, md);
}

// --- report ---------------------------------------------------------------------------------
const line = passing === null
  ? `burndown: ${v1Tests.length} v1 tests specified (pass count needs --junit)`
  : `burndown: ${passing}/${v1Tests.length} v1 tests passing (${v1Tests.length - passing} to go)`;
console.log(line);
console.log(`coverage: ${coveredCount}/${live.length} live requirements have an integration test; ${excusedOnly.length} excused`);
for (const p of problems) console.error(`problem: ${p}`);
process.exitCode = problems.length ? 1 : 0;
