#!/usr/bin/env node
// Publishes the @packserver-canary fixture packs the prober reads, by trusted publishing.
//
//   node tools/canary/publish-canary.mjs [--registry <origin>] [--pack <@packserver-canary/name>]
//
// Run it from the job of a GitHub Actions workflow in the repository registered as the fixture
// packs' trusted publisher, with `permissions: id-token: write`; or, from a session, with
// PACKSERVER_OIDC_TOKEN set to a token minted for the registry's audience. A fixture whose version
// is already published is reported and left alone, so the script can run again.
import { pathToFileURL } from "node:url";
import { TextEncoder } from "node:util";
import { buildTree, canonicalise } from "../../packages/core/canonical/index.ts";
import { OIDC_AUDIENCE } from "../../packages/core/publishing/oidc.ts";

export const CANARY_SCOPE = "packserver-canary";
export const DEFAULT_REGISTRY = "https://registry.claudinite.com";

const SKILL = "---\nname: canary\ndescription: A fixture the registry's monitoring reads. Use when asked about the PackServer canary.\n---\n\nThis pack exists so the registry can prove it serves a known archive. It does nothing.\n";

/** The fixtures: fixed content at a fixed version, so the prober can pin their hashes. */
export const FIXTURES = [
  {
    pack: `@${CANARY_SCOPE}/notes`,
    version: "1.0.0",
    files: {
      "pack.json": `${JSON.stringify({ name: `@${CANARY_SCOPE}/notes`, version: "1.0.0", minEngineVersion: "1.61001.1" }, null, 2)}\n`,
      "README.md": `# @${CANARY_SCOPE}/notes\n\nA fixture the registry's monitoring reads.\n`,
      "skills/canary/SKILL.md": SKILL,
    },
  },
];

export function packFixture(fixture) {
  const encoder = new TextEncoder();
  const dirs = new Set();
  const files = Object.entries(fixture.files).map(([path, text]) => {
    const parts = path.split("/").slice(0, -1);
    parts.forEach((_, i) => dirs.add(parts.slice(0, i + 1).join("/")));
    return { path, executable: false, content: encoder.encode(text) };
  });
  return canonicalise(buildTree(files, [...dirs].sort()));
}

class Refused extends Error {
  constructor(step, response, body) {
    super(`${step}: HTTP ${response.status}${body?.reason ? `, ${body.reason}` : ""}${body?.message ? ` (${body.message})` : ""}`);
    this.step = step;
    this.reason = body?.reason ?? null;
  }
}

async function call(io, step, path, { method, bearer, body }) {
  const headers = { "user-agent": "packserver-canary-publisher" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await io.fetch(new URL(path, io.registry), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new Refused(step, response, parsed);
  return parsed;
}

async function oidcToken(env, fetchFn) {
  if (env.PACKSERVER_OIDC_TOKEN) return env.PACKSERVER_OIDC_TOKEN;
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = env;
  if (!url || !bearer) throw new Error("no OIDC token: run in a job with `permissions: id-token: write`, or set PACKSERVER_OIDC_TOKEN");
  const target = new URL(url);
  target.searchParams.set("audience", OIDC_AUDIENCE);
  const response = await fetchFn(target, { headers: { authorization: `Bearer ${bearer}` } });
  if (!response.ok) throw new Error(`the runner refused the OIDC token request (HTTP ${response.status})`);
  const { value } = await response.json();
  if (typeof value !== "string" || value === "") throw new Error("the runner's OIDC answer carried no token");
  return value;
}

/** One fixture's publish; the outcome is `published` with the run's verdict, or `exists`. */
export async function publishFixture(io, fixture, token) {
  const canonical = await packFixture(fixture);
  const archive = canonical.archive;
  const path = `/api/publish/${fixture.pack}/${fixture.version}`;
  let credential;
  try {
    ({ credential } = await call(io, "exchange", "/api/oidc/exchange", { method: "POST", body: { token, pack: fixture.pack, version: fixture.version, ...(io.job ? { job: io.job } : {}) } }));
  } catch (error) {
    if (error instanceof Refused && error.reason === "exists") return { pack: fixture.pack, version: fixture.version, outcome: "exists" };
    throw error;
  }
  const target = await call(io, "upload-url", `${path}/upload-url`, { method: "POST", bearer: credential, body: { content_length: archive.length } });
  const stored = await io.fetch(target.url, { method: "PUT", headers: target.headers, body: archive });
  if (!stored.ok) throw new Error(`upload: the storage host answered HTTP ${stored.status}`);
  await call(io, "uploaded", `${path}/uploaded`, { method: "POST", bearer: credential });
  let run = await call(io, "publish", path, { method: "POST", bearer: credential, body: { sha256: canonical.sha256 } });
  for (let polls = 0; run.status !== "finished"; polls++) {
    if (polls >= io.maxPolls) throw new Error(`run ${run.run_id} did not finish in time`);
    await io.sleep(io.pollMs);
    run = await call(io, "run status", `/api/publish/runs/${run.run_id}`, { method: "GET", bearer: credential });
  }
  return { pack: fixture.pack, version: fixture.version, outcome: "published", runId: run.run_id, verdict: run.verdict, sha256: canonical.sha256 };
}

const optionOf = (argv, name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

/** Exit code 0 when every fixture is published or already was with a pass or warn; 1 otherwise. */
export async function main(argv, env, deps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const log = deps.log ?? ((line) => console.log(line));
  const wanted = optionOf(argv, "--pack");
  const fixtures = FIXTURES.filter((f) => wanted === undefined || f.pack === wanted);
  if (fixtures.length === 0) {
    log(`no fixture named ${wanted}`);
    return 1;
  }
  const registry = optionOf(argv, "--registry") ?? env.PACKSERVER_BASE_URL ?? DEFAULT_REGISTRY;
  const io = {
    fetch: fetchFn,
    registry,
    job: env.GITHUB_JOB,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pollMs: deps.pollMs ?? 3_000,
    maxPolls: deps.maxPolls ?? 100,
  };
  let failed = false;
  for (const fixture of fixtures) {
    try {
      // A token buys one credential, so each fixture asks for its own.
      const token = await oidcToken(env, fetchFn);
      const result = await publishFixture(io, fixture, token);
      if (result.outcome === "exists") log(`${result.pack}@${result.version}: already published`);
      else {
        log(`${result.pack}@${result.version}: run ${result.runId} ${result.verdict}, sha256 ${result.sha256}`);
        if (result.verdict !== "pass" && result.verdict !== "warn") failed = true;
      }
    } catch (error) {
      log(`${fixture.pack}@${fixture.version}: ${error.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
