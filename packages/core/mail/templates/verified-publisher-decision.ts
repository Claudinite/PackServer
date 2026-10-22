import type { Notice } from "../notice";

/** REQ-SCOPE-018: a denial is explained. */
export interface VerifiedPublisherDecision {
  scope: string;
  decision: "granted" | "denied" | "revoked";
  reason: string | null;
  scopeUrl: string;
}

export const verifiedPublisherDecision = (d: VerifiedPublisherDecision): Notice => ({
  subject: `Verified Publisher ${d.decision} for ${d.scope}`,
  paragraphs: [
    `Verified Publisher status for ${d.scope} was ${d.decision}.`,
    ...(d.reason ? [`Reason: ${d.reason}`] : []),
  ],
  action: { label: "Open the scope", url: d.scopeUrl },
});
