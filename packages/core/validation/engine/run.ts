import { loadRules } from "@packserver/rules";
import type { Finding } from "@packserver/schema";
import { ArchiveRefusal } from "../../canonical/index.ts";
import { checkIdentity } from "../identity/index.ts";
import { checkManifest, type PackManifest } from "../manifest/index.ts";
import { checkText, type TextHygiene } from "../text/index.ts";
import { findingFactory, type MakeFinding } from "./rules.ts";
import type { StaticRuleInput, StaticRulePorts } from "./types.ts";

export interface StaticRuleResult {
  rulesVersion: string;
  findings: Finding[];
  manifest: PackManifest | null;
  urls: TextHygiene["urls"];
}

/** The finding for an archive the bounded extractor refused (step 3). */
export function archiveFinding(refusal: ArchiveRefusal, make: MakeFinding): Finding {
  return make(refusal.reason, { hint: `The archive was refused (${refusal.code}).` });
}

/** Steps 4 and 5 over an extracted tree. Pure apart from the injected lookups. */
export async function runStaticRules(input: StaticRuleInput, ports: StaticRulePorts): Promise<StaticRuleResult> {
  const make = findingFactory(loadRules(input.rulesVersion));
  const [manifest, identity] = await Promise.all([checkManifest(input, ports, make), checkIdentity(input.pack, ports, make)]);
  const text = checkText(input.tree, make);
  return {
    rulesVersion: input.rulesVersion,
    findings: [...manifest.findings, ...identity, ...text.findings],
    manifest: manifest.manifest,
    urls: text.urls,
  };
}
