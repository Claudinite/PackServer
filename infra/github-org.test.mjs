import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENVIRONMENTS, EXTRA_REPOS, GATE_CHECK, GATE_WORKFLOW, MAIN_CHECKS, MAIN_REPO, ORG, environmentBody, main, rulesetBody } from "./github-org.mjs";

// An in-memory GitHub: just enough of repos, rulesets and environments to apply and read back.
function fakeGitHub({ repos = [MAIN_REPO], failRulesetList = false, gate = false, hidePrivate = false, tamper } = {}) {
  const state = { repos: new Map(), rulesets: new Map(), envs: new Map(), policies: new Map(), nextId: 1, writes: [] };
  for (const r of repos) state.repos.set(r, { private: true });
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (status, json) => ({ status, text: async () => (json === undefined ? "" : JSON.stringify(json)) });
    if (method !== "GET") state.writes.push(`${method} ${path}`);
    let m;
    if (path === "/repos/Claudinite/PackServer/contents/.github/workflows/scenario-gate.yml") return gate ? reply(200, {}) : reply(404, { message: "Not Found" });
    if ((m = path.match(/^\/repos\/Claudinite\/([^/]+)$/)) && method === "GET") {
      if (hidePrivate) return reply(404, { message: "Not Found" });
      return state.repos.has(m[1]) ? reply(200, { name: m[1], ...state.repos.get(m[1]) }) : reply(404, { message: "Not Found" });
    }
    if (path === "/orgs/Claudinite/repos" && method === "POST") {
      state.repos.set(body.name, { private: body.private });
      return reply(201, { name: body.name });
    }
    if ((m = path.match(/^\/repos\/Claudinite\/([^/]+)\/rulesets$/))) {
      if (method === "GET") return failRulesetList ? reply(500, { message: "server error" }) : reply(200, [...(state.rulesets.get(m[1]) ? [state.rulesets.get(m[1])] : [])].map((r) => ({ id: r.id, name: r.name })));
      const rs = { id: state.nextId++, ...body };
      state.rulesets.set(m[1], rs);
      return reply(201, rs);
    }
    if ((m = path.match(/^\/repos\/Claudinite\/([^/]+)\/rulesets\/(\d+)$/))) {
      if (method === "PUT") {
        state.rulesets.set(m[1], { id: Number(m[2]), ...body });
        return reply(200, {});
      }
      const rs = structuredClone(state.rulesets.get(m[1]));
      if (tamper) tamper(rs);
      return reply(200, rs);
    }
    if ((m = path.match(/^\/repos\/Claudinite\/PackServer\/environments\/([^/]+)\/deployment-branch-policies$/))) {
      if (method === "GET") return reply(200, { total_count: 0, branch_policies: state.policies.get(m[1]) ?? [] });
      state.policies.set(m[1], [...(state.policies.get(m[1]) ?? []), { name: body.name }]);
      return reply(200, {});
    }
    if ((m = path.match(/^\/repos\/Claudinite\/PackServer\/environments\/([^/]+)$/))) {
      if (method === "PUT") {
        state.envs.set(m[1], body);
        return reply(200, {});
      }
      const e = state.envs.get(m[1]);
      return reply(200, {
        name: m[1],
        protection_rules: e.wait_timer ? [{ type: "wait_timer", wait_timer: e.wait_timer }] : [],
        deployment_branch_policy: e.deployment_branch_policy,
      });
    }
    return reply(404, { message: `unhandled ${method} ${path}` });
  };
  return { fetch, state };
}

const run = async (argv, env, deps) => {
  const out = [];
  const err = [];
  const code = await main(argv, env, { out: (s) => out.push(s), err: (s) => err.push(s), ...deps });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const ENV = { GH_ADMIN_TOKEN: "tok" };

describe("intended state", () => {
  it("requires only summary, and summary needs every product job in ci.yml", () => {
    expect(MAIN_CHECKS).toEqual(["summary"]);
    const yml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const jobs = yml.split(/^jobs:\n/m)[1];
    const keys = [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gm)].map((m) => m[1]);
    const needs = /^ {4}needs: \[([^\]]+)\]/m.exec(jobs.slice(jobs.indexOf("  summary:\n")))?.[1].split(",").map((n) => n.trim());
    expect(needs.sort()).toEqual(keys.filter((k) => k !== "summary").sort());
  });

  it("names the scenario-gate workflow's job as the context it requires", () => {
    const yml = readFileSync(new URL("../.github/workflows/scenario-gate.yml", import.meta.url), "utf8");
    expect(yml.split(/^jobs:\n/m)[1]).toMatch(new RegExp(`^ {2}${GATE_CHECK}:`, "m"));
    expect(GATE_WORKFLOW).toBe(".github/workflows/scenario-gate.yml");
  });

  it("has no bypass actors, no force push, PR-only and no code-owner approval requirement", () => {
    const rs = rulesetBody(MAIN_CHECKS);
    expect(rs.bypass_actors).toEqual([]);
    expect(rs.rules.map((r) => r.type)).toEqual(expect.arrayContaining(["pull_request", "non_fast_forward", "deletion", "required_status_checks"]));
    expect(rs.rules.find((r) => r.type === "pull_request").parameters.require_code_owner_review).toBe(false);
    expect(rs.conditions.ref_name.include).toEqual(["refs/heads/main"]);
  });

  it("omits required_status_checks when a repository has none", () => {
    expect(rulesetBody([]).rules.map((r) => r.type)).not.toContain("required_status_checks");
    for (const r of EXTRA_REPOS) expect(r.requiredChecks).toEqual([]);
  });

  it("gives production-irreversible a 30-minute timer and main-only deploys", () => {
    const e = ENVIRONMENTS.find((x) => x.name === "production-irreversible");
    expect(environmentBody(e)).toEqual({ wait_timer: 30, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    expect(ENVIRONMENTS.map((x) => x.name)).toEqual(["staging", "production", "production-rollback", "production-irreversible", "nightly"]);
  });

  it("lists the auxiliary repositories with their visibility", () => {
    expect(EXTRA_REPOS).toEqual([
      { name: "publish-pack", private: false, requiredChecks: [] },
      { name: "packserver-ops", private: true, requiredChecks: [] },
      { name: "packserver-probe", private: true, requiredChecks: [] },
      { name: "packserver-witness", private: true, requiredChecks: [] },
    ]);
    expect(ORG).toBe("Claudinite");
  });
});

describe("github-org.mjs", () => {
  it("prints usage on --help and refuses without GH_ADMIN_TOKEN", async () => {
    expect((await run(["--help"], {})).out).toContain("Usage: node infra/github-org.mjs");
    const r = await run([], {});
    expect(r.code).toBe(2);
    expect(r.err).toContain("GH_ADMIN_TOKEN");
  });

  it("dry-run makes no call", async () => {
    const gh = fakeGitHub();
    const r = await run(["--dry-run"], {}, { fetch: gh.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toContain("production-irreversible");
    expect(gh.state.writes).toEqual([]);
  });

  it("creates the repositories, rulesets and environments, then reads back clean", async () => {
    const gh = fakeGitHub();
    const r = await run([], ENV, { fetch: gh.fetch });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect([...gh.state.repos.keys()].sort()).toEqual(["PackServer", "packserver-ops", "packserver-probe", "packserver-witness", "publish-pack"]);
    expect(gh.state.repos.get("publish-pack").private).toBe(false);
    expect(gh.state.rulesets.size).toBe(5);
    expect(gh.state.policies.get("production-irreversible")).toEqual([{ name: "main" }]);
    expect(gh.state.policies.has("staging")).toBe(false);
    expect(r.out).toContain("environment production-irreversible: wait timer 30 min, deploys from main");
    expect(r.out).toContain(`skipping required check ${GATE_CHECK}`);
    const checksOf = (repo) => gh.state.rulesets.get(repo).rules.find((x) => x.type === "required_status_checks")?.parameters.required_status_checks.map((c) => c.context);
    expect(checksOf("PackServer")).toEqual(MAIN_CHECKS);
    expect(checksOf("publish-pack")).toBeUndefined();
    expect(r.out).toContain("All read-back checks match.");
  });

  it("requires scenario-gate once its workflow is on the default branch", async () => {
    const gh = fakeGitHub({ gate: true });
    const r = await run([], ENV, { fetch: gh.fetch });
    expect(r.code).toBe(0);
    expect(gh.state.rulesets.get("PackServer").rules.find((x) => x.type === "required_status_checks").parameters.required_status_checks.map((c) => c.context)).toContain(GATE_CHECK);
    expect(r.out).not.toContain("skipping");
  });

  it("does not read a 404 as absent when the token cannot see the organisation's repositories", async () => {
    const gh = fakeGitHub({ hidePrivate: true });
    const r = await run([], ENV, { fetch: gh.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("may lack access");
    expect(gh.state.writes.filter((w) => w === "POST /orgs/Claudinite/repos")).toEqual([]);
  });

  it("is idempotent: a second run updates in place and adds nothing", async () => {
    const gh = fakeGitHub();
    await run([], ENV, { fetch: gh.fetch });
    gh.state.writes.length = 0;
    const r = await run([], ENV, { fetch: gh.fetch });
    expect(r.code).toBe(0);
    expect(gh.state.writes.filter((w) => w.startsWith("POST"))).toEqual([]);
    expect(gh.state.rulesets.size).toBe(5);
    expect(gh.state.policies.get("production")).toHaveLength(1);
  });

  it("treats a failed ruleset listing as an error, never as absent", async () => {
    const gh = fakeGitHub({ failRulesetList: true });
    const r = await run([], ENV, { fetch: gh.fetch });
    expect(r.code).toBe(1);
    expect(gh.state.writes.filter((w) => w.includes("/rulesets"))).toEqual([]);
  });

  it("fails the read-back when a bypass actor appears", async () => {
    const gh = fakeGitHub({ tamper: (rs) => (rs.bypass_actors = [{ actor_id: 1, actor_type: "Integration", bypass_mode: "always" }]) });
    const r = await run([], ENV, { fetch: gh.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("bypass actors");
  });

  it("fails the read-back when a required check is dropped", async () => {
    const gh = fakeGitHub({
      tamper: (rs) => {
        const c = rs.rules.find((x) => x.type === "required_status_checks");
        if (c) c.parameters.required_status_checks = c.parameters.required_status_checks.slice(1);
      },
    });
    const r = await run([], ENV, { fetch: gh.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("required checks");
  });
});
