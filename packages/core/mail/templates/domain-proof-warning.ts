import type { Notice } from "../notice";

/** REQ-SCOPE-006: sent before the proof is removed. */
export interface DomainProofWarning {
  scope: string;
  domain: string;
  failedChecks: number;
  removalDate: string;
  scopeUrl: string;
}

export const domainProofWarning = (d: DomainProofWarning): Notice => ({
  subject: `Domain proof for ${d.scope} is failing`,
  paragraphs: [
    `The proof for ${d.domain} has failed ${d.failedChecks} re-check${d.failedChecks === 1 ? "" : "s"}. It will be removed on ${d.removalDate} unless it verifies again.`,
    "Restore the DNS record to keep the scope's domain verification.",
  ],
  action: { label: "Open the scope", url: d.scopeUrl },
});
