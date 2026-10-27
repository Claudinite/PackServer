import type { Meta } from "@packserver/schema";

/** The URL classes that tell the agent to install, fetch or run something (REQ-VAL-026). */
const EXECUTABLE_CLASSES: readonly string[] = ["install", "fetch", "execute"];

const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A resolvable name, not an address: only a name can lapse or change hands. */
export function resolvableDomain(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, "");
  return NAME.test(name) && !/^[0-9]+$/.test(name.slice(name.lastIndexOf(".") + 1)) ? name : null;
}

export const linkedDomains = (inventory: Meta["url_inventory"]): string[] => [...new Set(inventory.map((u) => resolvableDomain(u.domain)).filter((d): d is string => d !== null))].sort();

export interface DriftVerdict {
  /** Drifted domains an install, fetch or execute instruction points at: the version is quarantined. */
  quarantine: string[];
  /** Drifted domains only ordinary prose links: a warning on the version page and a notice to the publisher. */
  warn: string[];
}

export function driftVerdict(inventory: Meta["url_inventory"], drifted: ReadonlySet<string>): DriftVerdict {
  const instructed = new Set<string>();
  const linked = new Set<string>();
  for (const entry of inventory) {
    const domain = resolvableDomain(entry.domain);
    if (domain === null || !drifted.has(domain)) continue;
    linked.add(domain);
    if (EXECUTABLE_CLASSES.includes(entry.classification)) instructed.add(domain);
  }
  return { quarantine: [...instructed].sort(), warn: [...linked].filter((d) => !instructed.has(d)).sort() };
}
