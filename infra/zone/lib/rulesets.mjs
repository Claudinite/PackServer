// Zone rulesets (Transform, WAF, Cache, rate limiting). Only rules whose ref carries the managed
// prefix are ours: every other rule in a phase is kept exactly as found, and counts against the budget.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_PREFIX } from "./spec.mjs";

const COMPARED = ["ref", "description", "expression", "action", "action_parameters", "ratelimit"];
const READ_ONLY = ["id", "version", "last_updated"];

const stable = (v) => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
};
export const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// True when everything declared in `want` is present in `have`; fields the API adds are ignored.
export function covers(want, have) {
  if (Array.isArray(want)) return Array.isArray(have) && want.length === have.length && want.every((w, i) => covers(w, have[i]));
  if (want && typeof want === "object") return have && typeof have === "object" && Object.keys(want).every((k) => covers(want[k], have[k]));
  return want === have;
}

const withoutReadOnly = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !READ_ONLY.includes(k)));

export const normaliseRule = (r) => {
  const out = { enabled: r.enabled ?? true };
  for (const k of COMPARED) if (r[k] !== undefined) out[k] = r[k];
  return out;
};
const isManaged = (r) => typeof r.ref === "string" && r.ref.startsWith(MANAGED_PREFIX);

// Only the "no entry point ruleset yet" answer is treated as absent; any other failure, or a
// shape we do not recognise, stops the phase.
async function readEntrypoint(api, zoneId, phase) {
  let json;
  try {
    json = await api("GET", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
  } catch (e) {
    if (e.status === 404 && e.codes?.includes(10003)) return null;
    throw e;
  }
  const rs = json.result;
  if (typeof rs?.id !== "string" || rs.phase !== phase || (rs.rules !== undefined && !Array.isArray(rs.rules))) {
    throw new Error(`unrecognised entry point ruleset for ${phase}`);
  }
  return { id: rs.id, rules: rs.rules ?? [] };
}

export async function countRules(api, zoneId, phase) {
  return (await readEntrypoint(api, zoneId, phase))?.rules.length ?? 0;
}

const matches = (desired, existing) => desired.length === existing.length && desired.every((d, i) => covers(normaliseRule(d), normaliseRule(existing[i])));

export async function ensurePhase({ api, zoneId, phase, desired, budget, write, out, backupDir, now, otherRules = 0 }) {
  const label = `${budget.kind} (${phase})`;
  const current = await readEntrypoint(api, zoneId, phase);
  const existing = current?.rules ?? [];
  const unmanaged = existing.filter((r) => !isManaged(r));
  const total = unmanaged.length + desired.length + otherRules;
  if (total > budget.max) {
    throw new Error(`${label}: ${unmanaged.length + otherRules} existing rule(s) plus ${desired.length} of ours is ${total}, over the Free-plan limit of ${budget.max}; nothing was changed`);
  }
  const managedNow = existing.filter(isManaged);
  if (matches(desired, managedNow)) {
    out(`ok       ${label}: ${desired.length} rule(s)`);
    return { changed: false };
  }
  if (!write) {
    out(`would    update ${label}: ${desired.map((r) => r.ref).join(", ")}`);
    return { changed: true };
  }
  if (current) {
    mkdirSync(backupDir, { recursive: true });
    const file = join(backupDir, `${now().replace(/[:.]/g, "-")}-${phase}.json`);
    writeFileSync(file, `${JSON.stringify({ id: current.id, phase, rules: existing }, null, 2)}\n`);
    out(`saved    previous ${phase} rule set to ${file}`);
  }
  const rules = [...unmanaged.map(withoutReadOnly), ...desired];
  if (current) await api("PUT", `/zones/${zoneId}/rulesets/${current.id}`, { rules });
  else await api("POST", `/zones/${zoneId}/rulesets`, { name: `PackServer ${phase}`, kind: "zone", phase, rules });
  const after = await readEntrypoint(api, zoneId, phase);
  if (!after || !matches(desired, after.rules.filter(isManaged))) {
    throw new Error(`${label}: the rule set read back after the update does not match what was sent`);
  }
  out(`updated  ${label}: ${desired.map((r) => r.ref).join(", ")}`);
  return { changed: true };
}

export async function ensureSmartTieredCache({ api, zoneId, write, out }) {
  const path = `/zones/${zoneId}/cache/tiered_cache_smart_topology_enable`;
  const state = (await api("GET", path)).result?.value;
  if (state !== "on" && state !== "off") throw new Error("unrecognised Smart Tiered Cache state");
  if (state === "on") {
    out("ok       smart tiered cache on");
    return;
  }
  if (!write) {
    out("would    turn smart tiered cache on");
    return;
  }
  await api("PATCH", path, { value: "on" });
  if ((await api("GET", path)).result?.value !== "on") throw new Error("smart tiered cache is still off after the update");
  out("updated  smart tiered cache on");
}
