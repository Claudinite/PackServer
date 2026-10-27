import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./apply.mjs";
import { datasetOf, exportEnv, loadSpec, readLayout, renderPanel, validateSpec } from "./lib/spec.mjs";
import { datasetFor, SIGNAL_NAMES } from "../../packages/core/telemetry/signals";
import { REQUEST_BLOBS, REQUEST_DOUBLES } from "../../packages/core/telemetry/event";
import { DOWNLOAD_BLOBS, DOWNLOAD_DOUBLES, SIGNAL_NUMBERS } from "../../packages/core/telemetry/recorder";
import { GATE_RESULT_BLOBS, GATE_RESULT_DOUBLES } from "../../packages/core/gates/layout";

const layout = readLayout();
const spec = loadSpec();
const panel = (sql, range = { n: 1, unit: "HOUR" }) => ({ id: "p", title: "p", kind: "table", range, sql });
const dash = (sql) => ({ dashboards: ["overview", "release", "publish-pipeline", "trust-abuse", "platform-cost"].map((id) => ({ id, title: id, purpose: id, panels: [panel(sql)] })) });

describe("the telemetry layout read from source", () => {
  it("matches what the code that writes the points exports", () => {
    expect(layout.columns.request_outcomes).toEqual({ blobs: [...REQUEST_BLOBS], doubles: [...REQUEST_DOUBLES] });
    expect(layout.columns.downloads).toEqual({ blobs: [...DOWNLOAD_BLOBS], doubles: [...DOWNLOAD_DOUBLES] });
    expect(layout.columns.gate_results).toEqual({ blobs: [...GATE_RESULT_BLOBS], doubles: [...GATE_RESULT_DOUBLES] });
    expect(layout.numbers).toEqual(Object.fromEntries(Object.entries(SIGNAL_NUMBERS).map(([k, v]) => [k, [...v]])));
    expect([...layout.signals].sort()).toEqual([...SIGNAL_NAMES].sort());
  });

  it("routes every signal to the dataset the recorder does", () => {
    for (const name of SIGNAL_NAMES) expect(datasetOf(name)).toBe(datasetFor(name));
  });
});

describe("the declaration", () => {
  it("is sound against the layout", () => {
    expect(validateSpec(spec, layout)).toEqual([]);
  });

  it("holds the five dashboards, each with panels", () => {
    expect(spec.dashboards.map((d) => d.id)).toEqual(["overview", "release", "publish-pipeline", "trust-abuse", "platform-cost"]);
    for (const d of spec.dashboards) expect(d.panels.length).toBeGreaterThanOrEqual(6);
  });

  it.each([
    ["a missing dashboard", { dashboards: spec.dashboards.slice(1) }, /"overview" is missing/],
    ["a field the dataset does not have", dash("SELECT {{col:request_outcomes.nope}} FROM {{ds:request_outcomes}} WHERE {{since}}"), /no field "nope"/],
    ["an unknown dataset", dash("SELECT 1 FROM {{ds:nothing}} WHERE {{since}}"), /unknown dataset/],
    ["a raw dataset name", dash("SELECT 1 FROM request_outcomes WHERE {{since}}"), /FROM must name a dataset/],
    ["no time bound", dash("SELECT 1 FROM {{ds:domain_events}}"), /must bound its time range/],
    ["a signal outside the catalogue", dash("SELECT 1 FROM {{ds:domain_events}} WHERE {{since}} AND index1 = 'publish.nope'"), /not in the signals catalogue/],
    ["a signal read from the wrong dataset", dash("SELECT 1 FROM {{ds:domain_events}} WHERE {{since}} AND index1 = 'gate.evaluated'"), /written to gate_results/],
    ["a numeric column no signal writes", dash("SELECT {{num:queue.backlog.nope}} FROM {{ds:domain_events}} WHERE {{since}}"), /no numeric column/],
    ["an outcome the recorder never writes", dash("SELECT 1 FROM {{ds:request_outcomes}} WHERE {{since}} AND {{col:request_outcomes.outcome}} = 'rate_limited'"), /not an outcome/],
    ["two datasets in one panel", dash("SELECT 1 FROM {{ds:domain_events}} WHERE {{since}} AND 1 IN (SELECT 1 FROM {{ds:budget}})"), /reads 2 datasets/],
    ["a statement separator", dash("SELECT 1 FROM {{ds:domain_events}} WHERE {{since}}; DROP"), /without a semicolon/],
  ])("refuses %s", (_, bad, message) => {
    expect(validateSpec(bad, layout).join("\n")).toMatch(message);
  });
});

describe("rendering", () => {
  const sample = panel("SELECT {{col:request_outcomes.outcome}} AS o, {{col:request_outcomes.duration_ms}} AS d, {{num:queue.backlog.oldest_age_s}} AS a, {{bucket:300}} AS t FROM {{ds:request_outcomes}} WHERE {{since}}", { n: 6, unit: "HOUR" });

  it("resolves fields to the columns the points use", () => {
    const sql = renderPanel(sample, "production", layout);
    expect(sql).toContain(`blob${REQUEST_BLOBS.indexOf("outcome") + 1} AS o`);
    expect(sql).toContain(`double${REQUEST_DOUBLES.indexOf("duration_ms") + 1} AS d`);
    expect(sql).toContain(`double${SIGNAL_NUMBERS["queue.backlog"].indexOf("oldest_age_s") + 1} AS a`);
    expect(sql).toContain("intDiv(toUInt32(timestamp), 300) * 300 AS t");
    expect(sql).toContain("timestamp > NOW() - INTERVAL '6' HOUR");
    expect(sql.endsWith("FORMAT JSON")).toBe(true);
  });

  it("suffixes datasets for staging only", () => {
    expect(renderPanel(sample, "production", layout)).toContain("FROM request_outcomes WHERE");
    expect(renderPanel(sample, "staging", layout)).toContain("FROM request_outcomes_staging WHERE");
  });

  it("refuses an unknown environment", () => {
    expect(() => renderPanel(sample, "test", layout)).toThrow(/staging/);
  });

  it("exports every panel with no token left", () => {
    for (const env of ["staging", "production"]) {
      const text = JSON.stringify(exportEnv(spec, env, layout));
      expect(text).not.toMatch(/\{\{/);
    }
  });

  it("matches probe summary rows by the attributes the prober writes", () => {
    const attrs = JSON.stringify({ target: "v1", run: "r", scenario: "summary", ok: true, index_ok: false, stale_s: 4 });
    expect(attrs).toContain('"scenario":"summary"');
    expect(attrs).toContain('"ok":true');
    expect(attrs).not.toContain('"ok":false');
    expect(JSON.stringify({ scenario: "summary", ok: false, index_ok: true })).not.toContain('"ok":true');
  });
});

describe("main", () => {
  const run = async (argv, env = {}, deps = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, env, { out: (s) => out.push(s), err: (s) => err.push(s), ...deps });
    return { code, out, err };
  };

  it("validates offline by default and calls nothing", async () => {
    const { code, out } = await run([], {}, { fetch: () => { throw new Error("network"); } });
    expect(code).toBe(0);
    expect(out).toHaveLength(5);
  });

  it("writes the rendered dashboards for an environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-"));
    const { code } = await run(["--env", "staging", "--export", dir]);
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, "staging.json"), "utf8"));
    expect(written.env).toBe("staging");
    expect(JSON.stringify(written)).toContain("request_outcomes_staging");
  });

  it("needs an environment to export or run", async () => {
    expect((await run(["--run"])).code).toBe(2);
    expect((await run(["--env", "test"])).code).toBe(2);
  });

  it("runs panels through an injected fetch and reports each result", async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, auth: init.headers.authorization, sql: init.body });
      return { ok: true, status: 200, json: async () => ({ data: [{ n: 1 }] }) };
    };
    const { code, out } = await run(["--env", "production", "--run", "--dashboard", "overview"], { CLOUDFLARE_ACCOUNT_ID: "acct", CF_ANALYTICS_READ_TOKEN: "tok" }, { fetch });
    expect(code).toBe(0);
    expect(seen).toHaveLength(spec.dashboards[0].panels.length);
    expect(seen[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql");
    expect(seen[0].auth).toBe("Bearer tok");
    expect(out.filter((l) => l.startsWith("{"))).toHaveLength(seen.length);
  });

  it("reports a panel it could not read and fails, never showing it empty", async () => {
    const fetch = async () => ({ ok: false, status: 403, text: async () => "denied" });
    const { code, err, out } = await run(["--env", "staging", "--run", "--dashboard", "release"], { CLOUDFLARE_ACCOUNT_ID: "a", CF_ANALYTICS_READ_TOKEN: "t" }, { fetch });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/not read: the SQL API answered 403/);
    expect(out.join("\n")).not.toMatch(/\(0 rows\)/);
  });

  it("refuses to run without credentials", async () => {
    expect((await run(["--env", "staging", "--run"])).code).toBe(2);
  });
});
