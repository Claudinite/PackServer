import type { Notice } from "../notice";

/**
 * REQ-MOD-013: stargazers who opted in get a digest of withdrawals; reporters of
 * open reports on a version get the same notice with just that version.
 */
export interface VersionWithdrawn {
  items: Array<{
    pack: string;
    version: string;
    action: "yanked" | "deprecated";
    reason: string | null;
    url: string;
  }>;
}

export const versionWithdrawn = (d: VersionWithdrawn): Notice => {
  const [only] = d.items;
  if (!only) throw new Error("a withdrawal notice needs at least one item");
  return {
    subject:
      d.items.length === 1
        ? `${only.pack} ${only.version} was ${only.action}`
        : `${d.items.length} versions you follow were withdrawn`,
    paragraphs: d.items.map(
      (i) => `${i.pack} ${i.version} was ${i.action} by its publisher.${i.reason ? ` Reason: ${i.reason}` : ""}`,
    ),
    links: d.items.map((i) => ({ label: `Open ${i.pack}`, url: i.url })),
  };
};
