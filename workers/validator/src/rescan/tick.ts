import { weekOf } from "@packserver/core/validation";
import { loadRules } from "@packserver/rules";
import type { ValidatorRuntime } from "../bindings";
import { pinnedRules, stat } from "../workflow/steps";
import { LookupBudgetSpent, rescanDomains, type DomainRun } from "./domains";
import { applyPipelineResults, startPipelineRun } from "./pipeline";
import { rescanRules } from "./rules";
import { advancePass, openPass, packsAfter, topDeclared, type Candidate, type Pass, type PassKind } from "./store";

/** The packs declared by the most public repositories that get the full pipeline each week. */
export const TOP_DECLARED = 1_000;
/** The resolver lookups one fire makes; a version links a handful of domains, so this keeps a fire inside a Worker's subrequest allowance. */
const LOOKUPS_PER_FIRE = 150;

export interface Progress {
  kind: PassKind | "collect";
  trigger: string;
  visited: number;
  findings: number;
  /** Whether the pass for this trigger has now visited everything. */
  completed: boolean;
}

const nowIso = (rt: ValidatorRuntime): string => new Date(rt.ports.clock.now()).toISOString();

async function finish(rt: ValidatorRuntime, pass: Pass, step: { cursor: string | null; versions: number; findings: number; done: boolean }): Promise<Progress> {
  await advancePass(rt.ports.d1, pass, step, nowIso(rt));
  if (step.done) stat(rt, "rescan.completed", [pass.kind, pass.trigger], [pass.versions + step.versions, pass.findings + step.findings]);
  return { kind: pass.kind, trigger: pass.trigger, visited: step.versions, findings: step.findings, completed: step.done };
}

/** One page of the rules pass: versions validated under older rules are rescanned and rescored. */
export async function rulesPass(rt: ValidatorRuntime): Promise<Progress> {
  const latest = loadRules(pinnedRules());
  const pass = await openPass(rt.ports.d1, "rules", latest.version, nowIso(rt));
  if (pass.completed) return { kind: "rules", trigger: pass.trigger, visited: 0, findings: 0, completed: true };
  const page = await packsAfter(rt.ports.d1, pass.cursor, rt.config.rescanBatch());
  let visited = 0;
  let findings = 0;
  for (const candidate of page.candidates) {
    const result = await rescanRules(rt, candidate, latest);
    if (result.judged) visited++;
    findings += result.found;
  }
  return finish(rt, pass, { cursor: page.last, versions: visited, findings, done: page.exhausted });
}

/** One page of the weekly domain pass. */
export async function domainsPass(rt: ValidatorRuntime): Promise<Progress> {
  const trigger = weekOf(rt.ports.clock.now());
  const pass = await openPass(rt.ports.d1, "domains", trigger, nowIso(rt));
  if (pass.completed) return { kind: "domains", trigger, visited: 0, findings: 0, completed: true };
  const page = await packsAfter(rt.ports.d1, pass.cursor, rt.config.rescanBatch());
  const run: DomainRun = { trigger, lookups: LOOKUPS_PER_FIRE, decided: new Map() };
  let visited = 0;
  let findings = 0;
  let cursor = pass.cursor;
  let spent = false;
  for (const candidate of page.candidates) {
    try {
      const result = await rescanDomains(rt, candidate, run);
      if (result.checked) visited++;
      findings += (result.quarantined ? 1 : 0) + result.warned;
    } catch (error) {
      if (!(error instanceof LookupBudgetSpent)) throw error;
      spent = true;
      break;
    }
    cursor = candidate.pack_id;
  }
  return finish(rt, pass, { cursor: spent ? cursor : page.last, versions: visited, findings, done: !spent && page.exhausted });
}

/** One page of the weekly full-pipeline pass over the most-declared packs; the verdicts of the runs it started are applied by `collect`. */
export async function pipelinePass(rt: ValidatorRuntime): Promise<Progress> {
  const trigger = weekOf(rt.ports.clock.now());
  const done = (visited: number): Progress => ({ kind: "pipeline", trigger, visited, findings: 0, completed: true });
  const scan = await topDeclared(rt.ports.d1, 0, 1, TOP_DECLARED);
  if (!scan.scanned) return { kind: "pipeline", trigger, visited: 0, findings: 0, completed: false };
  const pass = await openPass(rt.ports.d1, "pipeline", trigger, nowIso(rt));
  if (pass.completed) return done(0);
  const offset = pass.cursor === null ? 0 : Number(pass.cursor);
  const page = await topDeclared(rt.ports.d1, offset, rt.config.rescanBatch(), TOP_DECLARED);
  let started = 0;
  for (const candidate of page.candidates) if ((await startPipelineRun(rt, candidate, trigger)).started) started++;
  const next = Math.min(offset + rt.config.rescanBatch(), TOP_DECLARED);
  return finish(rt, pass, { cursor: String(next), versions: started, findings: 0, done: page.exhausted });
}

export async function collect(rt: ValidatorRuntime): Promise<Progress> {
  const applied = await applyPipelineResults(rt, rt.config.rescanBatch());
  return { kind: "collect", trigger: weekOf(rt.ports.clock.now()), visited: applied.applied, findings: applied.quarantined, completed: applied.applied === 0 };
}

export type Job = "rules" | "domains" | "pipeline" | "collect";

export const JOBS: Record<Job, (rt: ValidatorRuntime) => Promise<Progress>> = { rules: rulesPass, domains: domainsPass, pipeline: pipelinePass, collect };

/**
 * One scheduled fire: a page of each open pass. Passes are independent, so one that cannot proceed
 * (a resolver outage, say) does not hold the others up; its error is logged and the next fire
 * resumes it from its cursor.
 */
export async function tick(rt: ValidatorRuntime): Promise<Progress[]> {
  const out: Progress[] = [];
  for (const job of ["collect", "rules", "domains", "pipeline"] as const) {
    try {
      out.push(await JOBS[job](rt));
    } catch (error) {
      console.log(JSON.stringify({ event: "validator.rescan_failed", job, reason: String(error) }));
    }
  }
  return out;
}

export type { Candidate };
