import type { Notice } from "../notice";

/** REQ-SCOPE-009: the GitHub App was uninstalled, so the organisation proof is on a 7-day clock. */
export interface GithubOrgProofAlert {
  scope: string;
  org: string;
  removalDate: string;
  scopeUrl: string;
}

export const githubOrgProofAlert = (d: GithubOrgProofAlert): Notice => ({
  subject: `GitHub App removed from ${d.org}`,
  paragraphs: [
    `The GitHub App was uninstalled from ${d.org}. The proof of ${d.org} for ${d.scope} ends on ${d.removalDate} unless the App is installed again.`,
    "Install the App again, or sign in with GitHub as an owner of the organisation, to keep the proof.",
  ],
  action: { label: "Open the scope", url: d.scopeUrl },
});
