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
  }>;
  packUrl: string;
}

export const versionWithdrawn = (d: VersionWithdrawn): Notice => {
  const [only] = d.items;
  return {
    subject:
      d.items.length === 1 && only
        ? `${only.pack} ${only.version} was ${only.action}`
        : `${d.items.length} versions you follow were withdrawn`,
    paragraphs: d.items.map(
      (i) => `${i.pack} ${i.version} was ${i.action} by its publisher.${i.reason ? ` Reason: ${i.reason}` : ""}`,
    ),
    action: { label: "Open the pack", url: d.packUrl },
  };
};
