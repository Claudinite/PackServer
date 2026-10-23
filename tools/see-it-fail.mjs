#!/usr/bin/env node
// Nightly: every scenario added since <ref> must fail against the build from before it was added.
//
//   node tools/see-it-fail.mjs --since <ref> --command "<shell command with {id}>" [--exempt file]
//
// The command runs one scenario by its test id against the base build; a non-zero exit is the red
// the scenario owes. A pass is reported unless the id is exempted, either by an
// "Scenario-Already-Green: IT-… <reason>" line in the --exempt file (the merged pull request
// bodies) or because the run never reached the system (an InfrastructureError is not a red).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitSource, loadScenarios } from "./check-scenarios.mjs";

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);

export function newScenarioIds(before, after) {
  const ids = (src) => new Set(loadScenarios(src).filter((f) => !f.harness).flatMap((f) => f.scenarios.map((s) => s.id).filter(Boolean)));
  const old = ids(before);
  return [...ids(after)].filter((id) => !old.has(id));
}

export function exemptIds(text) {
  return new Set([...text.matchAll(/^\s*Scenario-Already-Green:\s*((?:IT-[A-Z]+|JT)-\d{3})/gim)].map((m) => m[1]));
}

export function judge(result) {
  if (/InfrastructureError/.test(result.output)) return "infrastructure";
  return result.status === 0 ? "green" : "red";
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const since = arg("--since");
  const command = arg("--command");
  if (!since || !command?.includes("{id}")) throw new Error('usage: --since <ref> --command "<shell command with {id}>" [--exempt file]');
  const exempt = arg("--exempt") ? exemptIds(readFileSync(arg("--exempt"), "utf8")) : new Set();
  const fresh = newScenarioIds(gitSource(root, since), gitSource(root, "HEAD"));
  const problems = [];
  for (const id of fresh) {
    const run = spawnSync("sh", ["-c", command.replaceAll("{id}", id)], { encoding: "utf8", cwd: root });
    const verdict = judge({ status: run.status, output: `${run.stdout}${run.stderr}` });
    console.log(`${id}: ${verdict}${verdict === "green" && exempt.has(id) ? " (exempt)" : ""}`);
    if (verdict === "green" && !exempt.has(id)) problems.push(`${id} passes on the build before it was added; show its red or declare Scenario-Already-Green`);
  }
  if (fresh.length === 0) console.log(`see-it-fail: no scenario added since ${since}`);
  for (const p of problems) console.error(`problem: ${p}`);
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
