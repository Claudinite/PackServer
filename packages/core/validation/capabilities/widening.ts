import type { Capability, CapabilitySet, PreInstallManifest } from "@packserver/schema";

/** The capabilities whose arrival makes a version wait for the owner's passkey (REQ-VAL-052). */
export const WIDENING = new Set<string>(["guard", "coded-check", "task:opens-pr", "task:agentic-phase", "env-setup", "forced-skill"]);

const widens = (c: Capability) => WIDENING.has(c) || c.startsWith("github-action:");

/** True when `next` holds a widening capability that `prev` lacks. A plain task, or a prose change, never widens. */
export function isWidening(prev: CapabilitySet | null, next: CapabilitySet): boolean {
  const had = new Set<string>(prev ?? []);
  return next.some((c) => widens(c) && !had.has(c));
}

type Body = Omit<PreInstallManifest, "new">;

/** Manifest entries the previous promoted version lacked, as `kind:name`; no previous marks everything. */
export function newEntries(prev: Body | null, next: Body, prevCaps: CapabilitySet | null, nextCaps: CapabilitySet): string[] {
  const out: string[] = [];
  const had = new Set<string>(prevCaps ?? []);
  for (const c of ["coded-check", "env-setup"] as const) if (nextCaps.includes(c) && !had.has(c)) out.push(c);
  for (const g of next.guards) {
    const p = prev?.guards.find((x) => x.name === g.name);
    if (!p || g.tool_calls.some((t) => !p.tool_calls.includes(t))) out.push(`guard:${g.name}`);
  }
  for (const t of next.tasks) {
    const p = prev?.tasks.find((x) => x.name === t.name);
    if (!p || (t.opens_pr && !p.opens_pr) || (t.agentic_phase && !p.agentic_phase)) out.push(`task:${t.name}`);
  }
  const prevForced = new Set(prev?.forced_skills ?? []);
  for (const s of next.forced_skills) if (!prevForced.has(s)) out.push(`forced-skill:${s}`);
  const prevActions = new Set(prev?.github_actions ?? []);
  for (const a of next.github_actions) if (!prevActions.has(a)) out.push(`github-action:${a}`);
  return out;
}
