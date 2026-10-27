#!/usr/bin/env node
// Organisation hygiene for REQ-OPS-013: deployment environments, the `main` ruleset and the
// auxiliary repositories. Idempotent; a failed lookup is an error, never "absent".
// REST: https://docs.github.com/en/rest/repos/rules, /deployments/environments,
// /deployments/branch-policies, /repos/repos#create-an-organization-repository
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const ORG = "Claudinite";
export const MAIN_REPO = "PackServer";
export const RULESET_NAME = "main-protection";
// The one required check: `summary` needs every product job and fails when any failed or was
// cancelled, so a change to a job's matrix never changes what the ruleset requires.
export const MAIN_CHECKS = ["summary"];
export const GATE_CHECK = "scenario-gate";
export const GATE_WORKFLOW = ".github/workflows/scenario-gate.yml";

// `branch: "main"` limits deployments to that branch; `waitMinutes` is the approval timer.
export const ENVIRONMENTS = [
  { name: "staging" },
  { name: "production", branch: "main" },
  { name: "production-rollback", branch: "main" },
  { name: "production-irreversible", branch: "main", waitMinutes: 30 },
  { name: "nightly" },
];

// packserver-witness is not managed here: it is public and created from the upptime/upptime
// template, and Upptime commits straight to its default branch, so main-protection must not apply.
// Each repository starts with no required checks; the task that gives it CI adds them, because
// a required check that never runs makes the PR that would add that CI unmergeable.
export const EXTRA_REPOS = [
  { name: "publish-pack", private: false, requiredChecks: [] },
  { name: "packserver-ops", private: true, requiredChecks: [] },
  { name: "packserver-probe", private: true, requiredChecks: [] },
];

const USAGE = `Usage: node infra/github-org.mjs [--dry-run]

Applies, then reads back and prints, the state for the handover issue:
  repositories  ${EXTRA_REPOS.map((r) => `${ORG}/${r.name} (${r.private ? "private" : "public"})`).join(", ")}
                created when missing (with an initial commit so main exists)
  environments  on ${ORG}/${MAIN_REPO}: ${ENVIRONMENTS.map((e) => e.name).join(", ")}
                production* deploy from main only; production-irreversible has a 30-minute timer
  ruleset       "${RULESET_NAME}" on main of ${ORG}/${MAIN_REPO} and each repository above: pull request
                only, no force push, no deletion, no bypass actors. Required checks: ${MAIN_CHECKS.join(", ")}
                (+ ${GATE_CHECK} once ${GATE_WORKFLOW} is on the default branch) on ${MAIN_REPO};
                none on the other repositories until their CI exists

Requires GH_ADMIN_TOKEN (fine-grained token, resource owner ${ORG}; see the M-06 checklist).
Exits 1 when the read-back differs from the intended state.

  --dry-run  print what would be applied; no network calls
  --help     this text
`;

export function rulesetBody(requiredChecks) {
  const rules = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        // CODEOWNERS routes review requests only; the author cannot approve their own PR, so
        // requiring a code-owner approval would stall every PR with a single human owner.
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ];
  if (requiredChecks.length) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: requiredChecks.map((context) => ({ context })),
      },
    });
  }
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules,
  };
}

export function environmentBody(env) {
  return {
    wait_timer: env.waitMinutes ?? 0,
    deployment_branch_policy: env.branch ? { protected_branches: false, custom_branch_policies: true } : null,
  };
}

export function createGitHub(fetchImpl, token) {
  return async function gh(method, path, body) {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  };
}

function expectOk(res, what) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what}: HTTP ${res.status}${res.json?.message ? ` ${res.json.message}` : ""}`);
  }
  return res.json;
}

async function ensureRepo(gh, repo, log) {
  const got = await gh("GET", `/repos/${ORG}/${repo.name}`);
  if (got.status === 200) {
    log(`repo ${ORG}/${repo.name}: exists`);
    return;
  }
  if (got.status !== 404) expectOk(got, `look up ${ORG}/${repo.name}`);
  // A fine-grained token that cannot see a private repository also gets 404, so confirm the
  // token sees the organisation's repositories before reading 404 as "absent".
  const seen = await gh("GET", `/repos/${ORG}/${MAIN_REPO}`);
  if (seen.status !== 200) {
    throw new Error(`${ORG}/${repo.name} answered 404 and the token cannot see ${ORG}/${MAIN_REPO} (HTTP ${seen.status}); the token may lack access to the organisation's repositories`);
  }
  expectOk(await gh("POST", `/orgs/${ORG}/repos`, { name: repo.name, private: repo.private, auto_init: true }), `create ${ORG}/${repo.name}`);
  log(`repo ${ORG}/${repo.name}: created`);
}

const PAGE = 100;

// The repository's own rulesets only (an organisation ruleset of the same name must never match),
// across every page.
async function listRulesets(gh, repo) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = expectOk(await gh("GET", `/repos/${ORG}/${repo}/rulesets?includes_parents=false&per_page=${PAGE}&page=${page}`), `list rulesets of ${repo}`);
    all.push(...batch);
    if (batch.length < PAGE) return all;
  }
}

// Decides each repository's required checks. scenario-gate is required only once its workflow
// exists on PackServer's default branch; before that it can never report and would block main.
export async function planChecks(gh, log) {
  const plan = new Map(EXTRA_REPOS.map((r) => [r.name, r.requiredChecks]));
  const gate = await gh("GET", `/repos/${ORG}/${MAIN_REPO}/contents/${GATE_WORKFLOW}`);
  if (gate.status === 200) {
    plan.set(MAIN_REPO, [...MAIN_CHECKS, GATE_CHECK]);
  } else if (gate.status === 404) {
    plan.set(MAIN_REPO, MAIN_CHECKS);
    log(`skipping required check ${GATE_CHECK}: ${GATE_WORKFLOW} is not on ${ORG}/${MAIN_REPO}'s default branch yet; rerun this script after it merges`);
  } else {
    expectOk(gate, `look up ${GATE_WORKFLOW}`);
  }
  return plan;
}

async function ensureRuleset(gh, repo, checks, log) {
  const list = await listRulesets(gh, repo);
  const found = list.find((r) => r.name === RULESET_NAME);
  if (found) {
    expectOk(await gh("PUT", `/repos/${ORG}/${repo}/rulesets/${found.id}`, rulesetBody(checks)), `update ruleset of ${repo}`);
    log(`ruleset ${repo}: updated`);
  } else {
    expectOk(await gh("POST", `/repos/${ORG}/${repo}/rulesets`, rulesetBody(checks)), `create ruleset of ${repo}`);
    log(`ruleset ${repo}: created`);
  }
}

async function ensureEnvironment(gh, env, log) {
  const base = `/repos/${ORG}/${MAIN_REPO}/environments/${env.name}`;
  expectOk(await gh("PUT", base, environmentBody(env)), `put environment ${env.name}`);
  if (env.branch) {
    const policies = expectOk(await gh("GET", `${base}/deployment-branch-policies`), `list branch policies of ${env.name}`);
    const names = (policies.branch_policies ?? []).map((p) => p.name);
    if (!names.includes(env.branch)) {
      expectOk(await gh("POST", `${base}/deployment-branch-policies`, { name: env.branch, type: "branch" }), `add branch policy to ${env.name}`);
    }
  }
  log(`environment ${env.name}: applied`);
}

// Returns lines describing the live state and the list of differences from the intent.
export async function readBack(gh, plan) {
  const lines = [];
  const problems = [];
  const repos = [{ name: MAIN_REPO }, ...EXTRA_REPOS];
  for (const repo of repos) {
    const meta = expectOk(await gh("GET", `/repos/${ORG}/${repo.name}`), `read ${repo.name}`);
    if (repo.private !== undefined && meta.private !== repo.private) {
      problems.push(`${repo.name}: private=${meta.private}, expected ${repo.private}`);
    }
    const list = await listRulesets(gh, repo.name);
    const summary = list.find((r) => r.name === RULESET_NAME);
    if (!summary) {
      problems.push(`${repo.name}: ruleset ${RULESET_NAME} missing`);
      continue;
    }
    const rs = expectOk(await gh("GET", `/repos/${ORG}/${repo.name}/rulesets/${summary.id}`), `read ruleset of ${repo.name}`);
    const types = rs.rules.map((r) => r.type).sort();
    const checks = (rs.rules.find((r) => r.type === "required_status_checks")?.parameters.required_status_checks ?? []).map((c) => c.context);
    const pr = rs.rules.find((r) => r.type === "pull_request")?.parameters;
    const wantChecks = plan.get(repo.name);
    const wantTypes = rulesetBody(wantChecks).rules.map((r) => r.type).sort();
    if (rs.enforcement !== "active") problems.push(`${repo.name}: ruleset enforcement is ${rs.enforcement}`);
    if ((rs.bypass_actors ?? []).length) problems.push(`${repo.name}: ruleset has bypass actors`);
    if (JSON.stringify(types) !== JSON.stringify(wantTypes)) problems.push(`${repo.name}: ruleset rules are ${types.join(",")}`);
    if (JSON.stringify([...checks].sort()) !== JSON.stringify([...wantChecks].sort())) problems.push(`${repo.name}: required checks are ${checks.join(",")}`);
    if (pr?.require_code_owner_review) problems.push(`${repo.name}: code-owner review is required, which would stall single-owner PRs`);
    if (JSON.stringify(rs.conditions?.ref_name?.include) !== JSON.stringify(["refs/heads/main"])) problems.push(`${repo.name}: ruleset does not target refs/heads/main`);
    lines.push(`${ORG}/${repo.name}: ${meta.private ? "private" : "public"}, ruleset ${rs.name} ${rs.enforcement}, bypass actors ${(rs.bypass_actors ?? []).length}, checks ${checks.join(", ") || "none"}`);
  }
  for (const env of ENVIRONMENTS) {
    const base = `/repos/${ORG}/${MAIN_REPO}/environments/${env.name}`;
    const live = expectOk(await gh("GET", base), `read environment ${env.name}`);
    const timer = (live.protection_rules ?? []).find((p) => p.type === "wait_timer")?.wait_timer ?? 0;
    let branches = "any branch";
    if (env.branch) {
      const pol = expectOk(await gh("GET", `${base}/deployment-branch-policies`), `read branch policies of ${env.name}`);
      const names = (pol.branch_policies ?? []).map((p) => p.name);
      branches = names.join(",") || "none";
      if (JSON.stringify(names) !== JSON.stringify([env.branch])) problems.push(`environment ${env.name}: branches are ${branches}`);
    } else if (live.deployment_branch_policy) {
      problems.push(`environment ${env.name}: restricted to branches, expected any`);
    }
    if (timer !== (env.waitMinutes ?? 0)) problems.push(`environment ${env.name}: wait timer ${timer}, expected ${env.waitMinutes ?? 0}`);
    lines.push(`environment ${env.name}: wait timer ${timer} min, deploys from ${branches}`);
  }
  return { lines, problems };
}

export async function main(argv, envVars, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { "dry-run": { type: "boolean" }, help: { type: "boolean" } }, strict: true }));
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (values["dry-run"]) {
    out(`[dry-run] would ensure repositories: ${EXTRA_REPOS.map((r) => `${ORG}/${r.name} (${r.private ? "private" : "public"})`).join(", ")}`);
    out(`[dry-run] would apply environments on ${ORG}/${MAIN_REPO}:`);
    for (const e of ENVIRONMENTS) out(`  ${e.name}: ${JSON.stringify(environmentBody(e))}${e.branch ? ` + branch policy ${e.branch}` : ""}`);
    out(`[dry-run] would apply this ruleset to ${[MAIN_REPO, ...EXTRA_REPOS.map((r) => r.name)].map((r) => `${ORG}/${r}`).join(", ")}:`);
    out(`[dry-run] ${MAIN_REPO} (checks ${MAIN_CHECKS.join(", ")}, plus ${GATE_CHECK} when ${GATE_WORKFLOW} exists):`);
    out(JSON.stringify(rulesetBody(MAIN_CHECKS), null, 2));
    out("[dry-run] the other repositories get the same ruleset without required_status_checks.");
    out("[dry-run] no network calls made.");
    return 0;
  }
  if (!envVars.GH_ADMIN_TOKEN) {
    err(`missing required environment: GH_ADMIN_TOKEN\n\n${USAGE}`);
    return 2;
  }
  const gh = createGitHub(deps.fetch ?? fetch, envVars.GH_ADMIN_TOKEN);
  try {
    const plan = await planChecks(gh, out);
    for (const repo of EXTRA_REPOS) await ensureRepo(gh, repo, out);
    for (const [name, checks] of plan) await ensureRuleset(gh, name, checks, out);
    for (const env of ENVIRONMENTS) await ensureEnvironment(gh, env, out);
    const { lines, problems } = await readBack(gh, plan);
    out("\nRead-back:");
    for (const l of lines) out(`  ${l}`);
    if (problems.length) {
      err("\nDrift from the intended state:");
      for (const p of problems) err(`  ${p}`);
      return 1;
    }
    out("\nAll read-back checks match.");
    return 0;
  } catch (e) {
    err(`failed: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
