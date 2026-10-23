import type { CapabilitySet, Finding, PreInstallManifest } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { checkCode } from "../code/index.ts";
import { findingFactory } from "../engine/rules.ts";
import { readManifest } from "../manifest/index.ts";
import { derivePreInstall, type Promoted } from "../manifest/preinstall.ts";
import { loadRules } from "@packserver/rules";
import { extractCapabilities } from "./index.ts";

export interface InspectorInput {
  tree: Tree;
  pack: string;
  /** The previous promoted version: its capability set alone, or the set with its pre-install manifest (needed to mark what is new). */
  previousCapabilities?: CapabilitySet | Promoted | null;
  rulesVersion?: string;
}

export interface InspectorResult {
  findings: Finding[];
  capabilities: { capabilities: CapabilitySet; preinstall: PreInstallManifest; widening: boolean };
}

export const DEFAULT_RULES_VERSION = "2026.10.1";

const isPromoted = (v: unknown): v is Promoted => !!v && typeof v === "object" && !Array.isArray(v) && "capabilities" in v && "preinstall" in v;

/**
 * With only the previous set, an entry cannot be told new from changed, so every entry whose capability
 * the set lacks is new and the rest are not.
 */
function previousOf(prev: InspectorInput["previousCapabilities"]): Promoted | null {
  if (prev === undefined || prev === null) return null;
  if (isPromoted(prev)) return prev;
  if (Array.isArray(prev)) return { capabilities: prev, preinstall: { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] } };
  return null;
}

/** Sandbox A's capability inspector: manifest, capability set, code rules and the pre-install manifest in one call. */
export const inspector = {
  name: "capabilities",
  async inspect(input: InspectorInput): Promise<InspectorResult> {
    const make = findingFactory(loadRules(input.rulesVersion ?? DEFAULT_RULES_VERSION));
    const read = readManifest(input.tree, make);
    const manifest = read.ok ? read.manifest : null;
    const extraction = extractCapabilities(input.tree, manifest);
    const findings = checkCode(input.tree, make, manifest, extraction);
    return { findings, capabilities: derivePreInstall(extraction, previousOf(input.previousCapabilities)) };
  },
};
