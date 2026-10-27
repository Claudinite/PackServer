#!/usr/bin/env node
// The five dashboards as code. Cloudflare offers no API that creates a dashboard over Analytics
// Engine data (see README.md), so this folder declares each panel as SQL, renders it per
// environment, and can run the panels to read them out.
//
//   (no mode)      validates the declaration against the telemetry layout in the source; no network
//   --export <dir> with --env: writes <dir>/<env>.json, the rendered dashboards; no network
//   --run          with --env: runs every panel against the Analytics Engine SQL API (read only) and
//                  prints each result; a panel that cannot be read is reported, never shown as empty
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ENVS } from "../lib/plan.mjs";
import { exportEnv, loadSpec, readLayout, renderPanel, validateSpec } from "./lib/spec.mjs";

const USAGE = `Usage: node infra/dashboards/apply.mjs [--env <staging|production>] [--export <dir>] [--run [--dashboard <id>]]

  (default)         validate the declaration offline and list the dashboards
  --export <dir>    write the rendered dashboards for --env to <dir>/<env>.json
  --run             run the panels of --env (all, or one --dashboard) against the SQL API
                    and print each; needs CLOUDFLARE_ACCOUNT_ID and CF_ANALYTICS_READ_TOKEN
                    (Account Analytics Read)
`;

export class RunError extends Error {}

async function runQuery(sql, { accountId, token, fetchImpl }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: sql,
  });
  if (!response.ok) throw new RunError(`the SQL API answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const rows = (await response.json()).data;
  if (!Array.isArray(rows)) throw new RunError("the SQL API answered without data");
  return rows;
}

export async function main(argv, envVars, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { env: { type: "string" }, export: { type: "string" }, run: { type: "boolean" }, dashboard: { type: "string" }, help: { type: "boolean" } }, strict: true }));
  } catch (e) {
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (values.env !== undefined && !ENVS.includes(values.env)) {
    err(`--env must be "staging" or "production", got "${values.env}"`);
    return 2;
  }
  if ((values.export !== undefined || values.run) && values.env === undefined) {
    err("--export and --run need --env");
    return 2;
  }

  const layout = readLayout(deps.root);
  const spec = loadSpec(deps.specPath);
  const problems = validateSpec(spec, layout);
  if (problems.length > 0) {
    for (const p of problems) err(p);
    return 1;
  }
  for (const d of spec.dashboards) out(`${d.id}: ${d.title} (${d.panels.length} panels)`);

  if (values.export !== undefined) {
    mkdirSync(values.export, { recursive: true });
    const path = join(values.export, `${values.env}.json`);
    writeFileSync(path, `${JSON.stringify(exportEnv(spec, values.env, layout), null, 2)}\n`);
    out(`wrote ${path}`);
  }

  if (values.run) {
    const accountId = envVars.CLOUDFLARE_ACCOUNT_ID;
    const token = envVars.CF_ANALYTICS_READ_TOKEN;
    if (!accountId || !token) {
      err("--run needs CLOUDFLARE_ACCOUNT_ID and CF_ANALYTICS_READ_TOKEN");
      return 2;
    }
    const dashboards = spec.dashboards.filter((d) => values.dashboard === undefined || d.id === values.dashboard);
    if (dashboards.length === 0) {
      err(`no dashboard "${values.dashboard}"`);
      return 2;
    }
    let failed = 0;
    for (const d of dashboards) {
      out(`\n== ${d.title}`);
      for (const p of d.panels) {
        try {
          const rows = await runQuery(renderPanel(p, values.env, layout), { accountId, token, fetchImpl: deps.fetch ?? fetch });
          out(`-- ${p.title} (${rows.length} rows)`);
          for (const row of rows) out(JSON.stringify(row));
        } catch (e) {
          failed += 1;
          err(`-- ${p.title}: not read: ${e.message}`);
        }
      }
    }
    if (failed > 0) return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
