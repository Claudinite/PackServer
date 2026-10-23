#!/usr/bin/env node
// Fails when the signals catalogue in code and the one in docs/operations/monitoring.md differ.
//
//   node tools/check-signals.mjs [--root dir]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CODE = "packages/schema/src/shapes/signals.ts";
const DOC = "docs/operations/monitoring.md";

/** `area: ["a", "b"]` entries of the SIGNALS object, as `area.a` names. */
export function signalsInCode(text) {
  const body = /export const SIGNALS = \{([\s\S]*?)\n\} as const/.exec(text)?.[1];
  if (body === undefined) throw new Error(`${CODE}: no SIGNALS object found`);
  const names = [];
  for (const m of body.matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
    for (const e of m[2].matchAll(/"([^"]+)"/g)) names.push(`${m[1]}.${e[1]}`);
  }
  return names;
}

export function datasetsInCode(text) {
  const body = /export const ANALYTICS_DATASETS = \[([\s\S]*?)\] as const/.exec(text)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The `**area**: \`a\`, \`b\`` bullets between "Areas and their signals" and "Datasets". */
export function signalsInDoc(text) {
  const section = /Areas and their signals:\n([\s\S]*?)\n\nDatasets:/.exec(text)?.[1];
  if (section === undefined) throw new Error(`${DOC}: no "Areas and their signals" list found`);
  const names = [];
  const parts = section.split(/\*\*(\w+)\*\*:/);
  for (let i = 1; i < parts.length; i += 2) {
    const span = parts[i + 1].replace(/\([^)]*\)/g, "");
    for (const e of span.matchAll(/`(\w+)`/g)) names.push(`${parts[i]}.${e[1]}`);
  }
  return names;
}

export function datasetsInDoc(text) {
  const line = /\nDatasets:([\s\S]*?)\n\n/.exec(text)?.[1] ?? "";
  return [...line.replace(/\([^)]*\)/g, "").matchAll(/`(\w+)`/g)].map((m) => m[1]);
}

const diff = (label, code, doc) => {
  const problems = [];
  for (const n of code) if (!doc.includes(n)) problems.push(`${label} ${n} is in code but not in ${DOC}`);
  for (const n of doc) if (!code.includes(n)) problems.push(`${label} ${n} is in ${DOC} but not in code`);
  for (const n of new Set(code)) if (code.filter((x) => x === n).length > 1) problems.push(`${label} ${n} is listed twice in code`);
  return problems;
};

export function checkSignals(codeText, docText) {
  return [
    ...diff("signal", signalsInCode(codeText), signalsInDoc(docText)),
    ...diff("dataset", datasetsInCode(codeText), datasetsInDoc(docText)),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--root");
  const root = i === -1 ? join(dirname(fileURLToPath(import.meta.url)), "..") : process.argv[i + 1];
  const problems = checkSignals(readFileSync(join(root, CODE), "utf8"), readFileSync(join(root, DOC), "utf8"));
  for (const p of problems) console.error(`problem: ${p}`);
  if (!problems.length) console.log("signals: the catalogue in code and in the monitoring doc agree");
  process.exitCode = problems.length ? 1 : 0;
}
