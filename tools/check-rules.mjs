// Usage: node tools/check-rules.mjs [rules-dir]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? join(import.meta.dirname, "../packages/rules");
const problems = [];
const CLASSES = ["fail", "hold", "warn"];
const PARTS = ["context_cost", "skill_structure", "checks", "source", "footprint"];
const CAPS = ["published_advisory", "no_public_repo"];
const PROSE_SCREENS = ["static-only"];

function read(version, name) {
  try {
    return JSON.parse(readFileSync(join(root, version, `${name}.json`), "utf8"));
  } catch (e) {
    problems.push(`${version}/${name}.json: ${e.message}`);
    return null;
  }
}

const versions = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}\.\d+\.\d+$/.test(d.name))
  .map((d) => d.name);
if (versions.length === 0) problems.push("no rules version directory found");

for (const v of versions) {
  const files = Object.fromEntries(
    ["static-rules", "score", "questions", "thresholds", "prose_screen"].map((n) => [n, read(v, n)]),
  );
  for (const [name, file] of Object.entries(files)) {
    if (file && file.version !== v) problems.push(`${v}/${name}.json: version is ${file.version}, expected ${v}`);
  }

  const sr = files["static-rules"];
  if (sr) {
    const ids = new Set();
    const security = new Set(sr.security_categories);
    for (const r of sr.rules) {
      if (ids.has(r.id)) problems.push(`${v}: duplicate rule id ${r.id}`);
      ids.add(r.id);
      if (!CLASSES.includes(r.class)) problems.push(`${v}: rule ${r.id} has class ${r.class}, not one of ${CLASSES}`);
      if (security.has(r.category) && r.class === "warn") {
        problems.push(`${v}: rule ${r.id} is in security category ${r.category} and is never warn`);
      }
      if (!r.description) problems.push(`${v}: rule ${r.id} has no description`);
    }
    for (const c of security) {
      if (!sr.rules.some((r) => r.category === c)) problems.push(`${v}: security category ${c} has no rule`);
    }
  }

  const sc = files.score;
  if (sc) {
    if (JSON.stringify(Object.keys(sc.parts).sort()) !== JSON.stringify([...PARTS].sort())) {
      problems.push(`${v}: score parts must be exactly ${PARTS}`);
    } else if (PARTS.reduce((n, p) => n + sc.parts[p], 0) !== 100) {
      problems.push(`${v}: score part weights must sum to 100`);
    }
    for (const c of CAPS) {
      if (!Number.isInteger(sc.caps?.[c]) || sc.caps[c] < 0 || sc.caps[c] > 100) problems.push(`${v}: cap ${c} missing or out of range`);
    }
  }

  const q = files.questions;
  const t = files.thresholds;
  if (q && t) {
    const qids = q.questions.map((x) => x.id).sort();
    const tids = Object.keys(t.questions).sort();
    if (JSON.stringify(qids) !== JSON.stringify(tids)) problems.push(`${v}: thresholds must cover exactly the question ids`);
    for (const [id, n] of Object.entries(t.questions)) {
      if (typeof n !== "number" || n < 0 || n > 1) problems.push(`${v}: threshold ${id} must be a probability`);
    }
  }

  const ps = files.prose_screen;
  if (ps && !PROSE_SCREENS.includes(ps.prose_screen)) problems.push(`${v}: unknown prose_screen ${ps.prose_screen}`);
}

for (const p of problems) console.error(p);
process.exitCode = problems.length ? 1 : 0;
