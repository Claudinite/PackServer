// The dashboards declaration, the telemetry layout it reads, and the rendering of a panel's SQL
// for one environment. Column positions are read from the source files that write the points, so
// a panel names a field and cannot drift from what is stored.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENVS } from "../../lib/plan.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const SPEC_PATH = join(import.meta.dirname, "..", "dashboards.json");

export const UNITS = ["MINUTE", "HOUR", "DAY"];
export const KINDS = ["timeseries", "table"];

/** Analytics Engine datasets carry the environment as a name suffix; production has none. */
export const datasetSuffix = (env) => (env === "staging" ? "_staging" : "");

/** Domain events and the datasets written like them: `Telemetry.emit` puts these in blobs 1 to 4. */
const EMITTED_BLOBS = ["worker", "release_id", "version_id", "attrs"];
const EMITTED_DATASETS = ["domain_events", "synthetic_probes", "budget"];

const read = (root, path) => readFileSync(join(root, path), "utf8");
const strings = (text) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

function constArray(root, path, name) {
  const body = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(read(root, path))?.[1];
  if (body === undefined) throw new Error(`${path}: no ${name} array found`);
  return strings(body);
}

/** The validator writes its statistics itself, each signal with its own blobs and doubles. */
function validationLayout(root) {
  const body = /export const VALIDATION_STAT_LAYOUT = \{([\s\S]*?)\n\} as const/.exec(read(root, "workers/validator/src/workflow/steps.ts"))?.[1];
  if (body === undefined) throw new Error("steps.ts: no VALIDATION_STAT_LAYOUT found");
  return Object.fromEntries(
    [...body.matchAll(/"([^"]+)":\s*\{\s*blobs:\s*\[([^\]]*)\],\s*doubles:\s*\[([^\]]*)\]/g)].map((m) => [m[1], { blobs: strings(m[2]), doubles: strings(m[3]) }]),
  );
}

function signalNumbers(root) {
  const body = /export const SIGNAL_NUMBERS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(read(root, "packages/core/telemetry/recorder.ts"))?.[1];
  if (body === undefined) throw new Error("recorder.ts: no SIGNAL_NUMBERS object found");
  return Object.fromEntries([...body.matchAll(/"([^"]+)":\s*\[([^\]]*)\]/g)].map((m) => [m[1], strings(m[2])]));
}

export function readLayout(root = REPO) {
  const signals = (() => {
    const body = /export const SIGNALS = \{([\s\S]*?)\n\} as const/.exec(read(root, "packages/schema/src/shapes/signals.ts"))?.[1];
    if (body === undefined) throw new Error("signals.ts: no SIGNALS object found");
    return [...body.matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)].flatMap((m) => strings(m[2]).map((e) => `${m[1]}.${e}`));
  })();
  return {
    signals: new Set(signals),
    datasets: constArray(root, "packages/schema/src/shapes/signals.ts", "ANALYTICS_DATASETS"),
    outcomes: constArray(root, "packages/core/telemetry/event.ts", "OUTCOMES"),
    columns: {
      request_outcomes: { blobs: constArray(root, "packages/core/telemetry/event.ts", "REQUEST_BLOBS"), doubles: constArray(root, "packages/core/telemetry/event.ts", "REQUEST_DOUBLES") },
      downloads: { blobs: constArray(root, "packages/core/telemetry/recorder.ts", "DOWNLOAD_BLOBS"), doubles: constArray(root, "packages/core/telemetry/recorder.ts", "DOWNLOAD_DOUBLES") },
      gate_results: { blobs: constArray(root, "packages/core/gates/layout.ts", "GATE_RESULT_BLOBS"), doubles: constArray(root, "packages/core/gates/layout.ts", "GATE_RESULT_DOUBLES") },
      ...Object.fromEntries(EMITTED_DATASETS.map((d) => [d, { blobs: EMITTED_BLOBS, doubles: [] }])),
    },
    numbers: signalNumbers(root),
    stats: validationLayout(root),
  };
}

/** The dataset a signal's point lands in, mirroring `datasetFor` in packages/core/telemetry/signals.ts. */
export function datasetOf(signal) {
  if (signal === "http.request") return "request_outcomes";
  if (signal === "download.served") return "downloads";
  if (signal.startsWith("validation.")) return "validation_events";
  if (signal === "synthetic.probe") return "synthetic_probes";
  if (signal === "gate.evaluated") return "gate_results";
  if (signal === "budget.usage") return "budget";
  return "domain_events";
}

export function loadSpec(path = SPEC_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const TOKEN = /\{\{([^}]*)\}\}/g;

function resolveToken(token, layout, suffix) {
  const [kind, arg] = token.split(/:(.*)/s);
  switch (kind) {
    case "ds": {
      if (!layout.datasets.includes(arg)) throw new Error(`unknown dataset "${arg}"`);
      return `${arg}${suffix}`;
    }
    case "col": {
      const [dataset, field] = arg.split(".");
      const columns = layout.columns[dataset];
      if (!columns) throw new Error(`dataset "${dataset}" has no declared columns`);
      if (field === "index1") return "index1";
      const blob = columns.blobs.indexOf(field);
      if (blob >= 0) return `blob${blob + 1}`;
      const double = columns.doubles.indexOf(field);
      if (double >= 0) return `double${double + 1}`;
      throw new Error(`${dataset} has no field "${field}"`);
    }
    case "num": {
      const at = arg.lastIndexOf(".");
      const columns = layout.numbers[arg.slice(0, at)];
      const double = columns?.indexOf(arg.slice(at + 1)) ?? -1;
      if (double < 0) throw new Error(`no numeric column "${arg}" in SIGNAL_NUMBERS`);
      return `double${double + 1}`;
    }
    case "stat": {
      const at = arg.lastIndexOf(".");
      const fields = layout.stats[arg.slice(0, at)];
      const field = arg.slice(at + 1);
      const blob = fields?.blobs.indexOf(field) ?? -1;
      if (blob >= 0) return `blob${blob + 1}`;
      const double = fields?.doubles.indexOf(field) ?? -1;
      if (double >= 0) return `double${double + 1}`;
      throw new Error(`no validator statistic field "${arg}"`);
    }
    case "bucket": {
      if (!/^[1-9]\d*$/.test(arg)) throw new Error(`bucket width must be whole seconds, got "${arg}"`);
      return `intDiv(toUInt32(timestamp), ${arg}) * ${arg}`;
    }
    default:
      throw new Error(`unknown token "{{${token}}}"`);
  }
}

export function renderPanel(panel, env, layout) {
  if (!ENVS.includes(env)) throw new Error(`env must be "staging" or "production", got "${env}"`);
  const suffix = datasetSuffix(env);
  const { n, unit } = panel.range;
  const sql = panel.sql.replace(TOKEN, (_, token) => (token === "since" ? `timestamp > NOW() - INTERVAL '${n}' ${unit}` : resolveToken(token, layout, suffix)));
  return `${sql} FORMAT JSON`;
}

/** Every problem with the declaration, as sentences; empty when it is sound. */
export function validateSpec(spec, layout) {
  const problems = [];
  const ids = new Set();
  const wanted = ["overview", "release", "publish-pipeline", "trust-abuse", "platform-cost"];
  const have = (spec.dashboards ?? []).map((d) => d.id);
  for (const id of wanted) if (!have.includes(id)) problems.push(`dashboard "${id}" is missing`);
  for (const id of have) if (!wanted.includes(id)) problems.push(`dashboard "${id}" is not one of the five`);
  for (const dash of spec.dashboards ?? []) {
    if (!dash.title || !dash.purpose || !(dash.panels ?? []).length) problems.push(`${dash.id}: needs a title, a purpose and panels`);
    for (const panel of dash.panels ?? []) {
      const at = `${dash.id}/${panel.id}`;
      if (ids.has(at)) problems.push(`${at}: duplicate panel id`);
      ids.add(at);
      if (!KINDS.includes(panel.kind)) problems.push(`${at}: kind must be one of ${KINDS.join(", ")}`);
      if (!Number.isInteger(panel.range?.n) || panel.range.n < 1 || !UNITS.includes(panel.range?.unit)) problems.push(`${at}: range needs a whole n and a unit of ${UNITS.join(", ")}`);
      if (!/^\s*SELECT\b/i.test(panel.sql) || panel.sql.includes(";")) problems.push(`${at}: sql must be one SELECT statement without a semicolon`);
      if (!panel.sql.includes("{{since}}")) problems.push(`${at}: sql must bound its time range with {{since}}`);
      if (/\bFROM\s+(?!\{\{ds:)/i.test(panel.sql)) problems.push(`${at}: FROM must name a dataset through {{ds:...}}`);
      if (/\bFORMAT\b/i.test(panel.sql)) problems.push(`${at}: FORMAT is appended on render`);
      for (const env of ENVS) {
        try {
          const sql = renderPanel(panel, env, layout);
          if (/\{\{|\}\}/.test(sql)) problems.push(`${at}: unresolved token`);
        } catch (e) {
          problems.push(`${at}: ${e.message}`);
          break;
        }
      }
      const datasets = new Set([...panel.sql.matchAll(/\{\{ds:([^}]+)\}\}/g)].map((m) => m[1]));
      if (datasets.size !== 1) problems.push(`${at}: reads ${datasets.size} datasets; a panel reads exactly one`);
      const [dataset] = datasets;
      const areas = new Set([...layout.signals].map((s) => s.split(".")[0]));
      const named = [...panel.sql.matchAll(/'([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]).filter((s) => areas.has(s.split(".")[0]));
      for (const s of named) {
        if (!layout.signals.has(s)) problems.push(`${at}: "${s}" is not in the signals catalogue`);
        else if (dataset && datasetOf(s) !== dataset) problems.push(`${at}: ${s} is written to ${datasetOf(s)}, not ${dataset}`);
      }
      for (const m of panel.sql.matchAll(/\{\{stat:([^}]+)\}\}/g)) {
        const signal = m[1].slice(0, m[1].lastIndexOf("."));
        if (dataset && datasetOf(signal) !== dataset) problems.push(`${at}: ${signal} is written to ${datasetOf(signal)}, not ${dataset}`);
      }
      for (const m of panel.sql.matchAll(/\{\{num:([^}]+)\}\}/g)) {
        const signal = m[1].slice(0, m[1].lastIndexOf("."));
        if (dataset && datasetOf(signal) !== dataset) problems.push(`${at}: ${signal} is written to ${datasetOf(signal)}, not ${dataset}`);
      }
      const outcomes = [...panel.sql.matchAll(/\{\{col:request_outcomes\.outcome\}\}\s*(?:=|IN)\s*\(?([^)]*?)(?:\)|\s+(?:AND|GROUP|ORDER)|$)/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
      for (const o of outcomes) if (!layout.outcomes.includes(o)) problems.push(`${at}: "${o}" is not an outcome the recorder writes`);
    }
  }
  return problems;
}

export function exportEnv(spec, env, layout) {
  return {
    env,
    dashboards: spec.dashboards.map((d) => ({
      id: d.id,
      title: d.title,
      purpose: d.purpose,
      panels: d.panels.map((p) => ({ id: p.id, title: p.title, kind: p.kind, ...(p.note ? { note: p.note } : {}), sql: renderPanel(p, env, layout) })),
    })),
  };
}
