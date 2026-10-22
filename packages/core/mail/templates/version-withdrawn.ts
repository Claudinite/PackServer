import type { Notice } from "../notice";

/** REQ-MOD-013: sent to stargazers who opted in and to reporters of open reports on the version. */
export interface VersionWithdrawn {
  pack: string;
  version: string;
  action: "yanked" | "deprecated";
  reason: string | null;
  packUrl: string;
}

export const versionWithdrawn = (d: VersionWithdrawn): Notice => ({
  subject: `${d.pack} ${d.version} was ${d.action}`,
  paragraphs: [
    `${d.pack} ${d.version} was ${d.action} by its publisher.`,
    ...(d.reason ? [`Reason: ${d.reason}`] : []),
  ],
  action: { label: "Open the pack", url: d.packUrl },
});
