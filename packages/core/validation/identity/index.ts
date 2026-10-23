import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import type { StaticRulePorts } from "../engine/types.ts";
import { isNearMiss } from "./similarity.ts";

export { editDistance, isNearMiss, skeleton } from "./similarity.ts";

export const RESERVED_WORDS: readonly string[] = ["admin", "claude", "anthropic", "claudinite", "cn", "fleet", "local", "global", "canon", "temp"];

const ASCII = /^[\x21-\x7e]+$/;

export function splitPackId(pack: string): { scope: string; name: string } {
  const m = /^@?([^/]*)\/(.*)$/.exec(pack);
  return m ? { scope: m[1]!, name: m[2]! } : { scope: "", name: pack };
}

function asciiFold(s: string): string {
  return s.normalize("NFKD").replace(/[^\x21-\x7e]/g, "").toLowerCase();
}

/** Step 4, identity half: ASCII names, reserved words, domain collisions and near misses. */
export async function checkIdentity(
  pack: string,
  ports: Pick<StaticRulePorts, "popularPacks" | "verifiedScopes" | "provenDomainLabels">,
  make: MakeFinding,
): Promise<Finding[]> {
  const { scope, name } = splitPackId(pack);
  const findings: Finding[] = [];
  const [popular, verifiedScopes, domains] = await Promise.all([ports.popularPacks(), ports.verifiedScopes(), ports.provenDomainLabels()]);

  const suggest = (): string => {
    const base = asciiFold(name) || "pack";
    const taken = (candidate: string) => popular.some((p) => isNearMiss(candidate, splitPackId(p).name) || candidate === splitPackId(p).name);
    for (const candidate of [`${base}-${asciiFold(scope) || "pack"}`, `${asciiFold(scope) || "my"}-${base}`, `${base}-pack`]) {
      if (!taken(candidate)) return `Try @${asciiFold(scope) || "scope"}/${candidate}.`;
    }
    return `Choose a different name than "${name}".`;
  };

  if (!ASCII.test(scope) || !ASCII.test(name)) {
    findings.push(make("identity.name-not-ascii", { quote: pack, hint: `Scope and pack names must be ASCII. ${suggest()}` }));
  }

  if (RESERVED_WORDS.includes(name)) {
    findings.push(make("identity.reserved-word", { quote: pack, hint: `"${name}" is a reserved word. ${suggest()}` }));
  }

  for (const d of domains) {
    if (d.scope !== scope && name === d.label) {
      findings.push(make("identity.verified-domain-collision", { quote: pack, hint: `"${name}" is the domain label of a verified publisher. ${suggest()}` }));
      break;
    }
  }

  let nearPopular: string | null = null;
  for (const p of popular) {
    const other = splitPackId(p);
    if (other.scope === scope) continue;
    if (isNearMiss(name, other.name) || isNearMiss(pack.replace(/^@?/, "@"), p)) {
      nearPopular = p;
      break;
    }
  }
  if (nearPopular) {
    findings.push(make("identity.near-popular-pack", { quote: pack, hint: `"${pack}" is too close to the popular pack ${nearPopular}. ${suggest()}` }));
  }

  for (const verified of verifiedScopes) {
    if (verified === scope) continue;
    if (isNearMiss(scope, verified) || isNearMiss(name, verified)) {
      findings.push(make("identity.near-verified-scope", { quote: pack, hint: `"${pack}" is a near miss on the verified scope @${verified}; a person will review it.` }));
      break;
    }
  }
  return findings;
}
