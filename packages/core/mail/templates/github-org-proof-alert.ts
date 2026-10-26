import type { Notice } from "../notice";

/** REQ-SCOPE-009: the GitHub App was uninstalled or suspended, so the organisation proof is on a 7-day clock. */
export interface GithubOrgProofAlert {
  scope: string;
  org: string;
  /** What happened to the App; the wording differs because a suspension is undone by unsuspending. */
  cause: "removed" | "suspended";
  removalDate: string;
  scopeUrl: string;
}

export const githubOrgProofAlert = (d: GithubOrgProofAlert): Notice =>
  d.cause === "suspended"
    ? {
        subject: `GitHub App suspended on ${d.org}`,
        paragraphs: [
          `The GitHub App was suspended on ${d.org}. The proof of ${d.org} for ${d.scope} ends on ${d.removalDate} unless the App is unsuspended.`,
          "Unsuspend the App in the organisation's GitHub settings, or sign in with GitHub as an owner of the organisation, to keep the proof.",
        ],
        action: { label: "Open the scope", url: d.scopeUrl },
      }
    : {
        subject: `GitHub App removed from ${d.org}`,
        paragraphs: [
          `The GitHub App was uninstalled from ${d.org}. The proof of ${d.org} for ${d.scope} ends on ${d.removalDate} unless the App is installed again.`,
          "Install the App again, or sign in with GitHub as an owner of the organisation, to keep the proof.",
        ],
        action: { label: "Open the scope", url: d.scopeUrl },
      };
