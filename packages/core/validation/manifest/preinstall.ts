import type { CapabilitySet, PreInstallManifest } from "@packserver/schema";
import { newEntries, isWidening, type Extraction } from "../capabilities/index.ts";

/** What a promoted version stored in its `meta.json`, which the next version is compared with. */
export interface Promoted {
  capabilities: CapabilitySet;
  preinstall: PreInstallManifest;
}

export interface PreInstallResult {
  capabilities: CapabilitySet;
  preinstall: PreInstallManifest;
  /** The version adds executable capability the previous promoted version lacked (REQ-VAL-052). */
  widening: boolean;
}

/** The pre-install manifest with its `new` list, and whether the version widens its predecessor. No predecessor marks everything new. */
export function derivePreInstall(extraction: Extraction, previous: Promoted | null): PreInstallResult {
  const { capabilities, preinstall } = extraction;
  const prevBody = previous ? { guards: previous.preinstall.guards, tasks: previous.preinstall.tasks, forced_skills: previous.preinstall.forced_skills, github_actions: previous.preinstall.github_actions } : null;
  return {
    capabilities,
    preinstall: { ...preinstall, new: newEntries(prevBody, preinstall, previous?.capabilities ?? null, capabilities) },
    widening: isWidening(previous?.capabilities ?? null, capabilities),
  };
}
