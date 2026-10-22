#!/usr/bin/env node
// Guards the scenario layer: scenario files stay in the domain language and
// trace to the requirements register. Runs before the tests (npm pretest).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const scenariosDir = join(root, "tests/scenarios");
const register = readFileSync(join(root, "requirements.md"), "utf8");
// Entries look like `## REQ-X-NNN Title` followed by a `- status: active|provisional|retired` list item.
const entries = [...register.matchAll(/^## (REQ-[A-Z]+-\d{3}) [^\n]*\n(?:\s*\n)?((?:- [^\n]*\n?)*)/gm)].map((m) => ({
  id: m[1],
  status: m[2].match(/^- status:\s*(\w+)/m)?.[1] ?? "active",
}));
const known = new Set(entries.map((e) => e.id));
const active = new Set(entries.filter((e) => e.status === "active").map((e) => e.id));

// Endpoint-language tokens that must not appear in a scenario file, code or comments.
const banned = [
  [/\bfetch\s*\(/, "a raw HTTP call"],
  [/https?:\/\//, "a URL"],
  [/['"`]\/(api|packs|auth|search|mcp)\b/, "an endpoint path"],
  [/\b(GET|POST|PUT|PATCH|DELETE)\b/, "an HTTP verb"],
  [/\b(status|statusCode)\b|\b[1-5]\d{2}\b(?![-\w])/, "a status code"],
  [/\b(SELECT|INSERT|UPDATE|DELETE)\s+(\*|INTO|FROM|SET)\b/i, "SQL"],
  [/\benv\.[A-Z_]{2,}\b/, "a binding"],
  [/^\s*(try|catch)\b/, "try/catch (expected failures are matchers)"],
  [/\b(it|test|describe)\.(skip|only|todo)\b/, "a disabled or focused test"],
  [/\b(setTimeout|sleep|Date\.now)\b/, "real time"],
  [/^\s*import\s.*from\s+['"](?!\.\.\/world\/scenario['"])/, "an import from outside the World"],
];

const problems = [];
const named = new Set();
for (const file of readdirSync(scenariosDir).filter((f) => f.endsWith(".scenario.ts"))) {
  const lines = readFileSync(join(scenariosDir, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [re, what] of banned) if (re.test(line)) problems.push(`${file}:${i + 1}: ${what}: ${line.trim()}`);
    const title = line.match(/^\s*scenario\(\s*['"`](.*?)['"`]/);
    if (title) {
      const ids = title[1].match(/\bREQ-[A-Z]+-\d{3}\b/g) ?? [];
      if (ids.length === 0) problems.push(`${file}:${i + 1}: scenario names no requirement`);
      for (const id of ids) {
        named.add(id);
        if (!known.has(id)) problems.push(`${file}:${i + 1}: ${id} is not in the register`);
      }
    }
  });
}
for (const id of active) if (!named.has(id)) problems.push(`requirements.md: ${id} has no scenario`);

if (problems.length) {
  console.error("scenario check failed:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`scenario check ok: ${named.size} requirements covered, ${active.size} active, ${known.size} listed`);
