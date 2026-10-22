import type { Notice } from "../notice";

/** REQ-SCOPE-018: a denial is explained. */
export type VerifiedPublisherDecision = { scope: string; scopeUrl: string } & (
  | { decision: "denied"; reason: string }
  | { decision: "granted" | "revoked"; reason?: string | null }
);

export const verifiedPublisherDecision = (d: VerifiedPublisherDecision): Notice => {
  if (d.decision === "denied" && !d.reason.trim()) throw new Error("a denial needs a reason");
  return {
    subject: `Verified Publisher ${d.decision} for ${d.scope}`,
    paragraphs: [
      `Verified Publisher status for ${d.scope} was ${d.decision}.`,
      ...(d.reason ? [`Reason: ${d.reason}`] : []),
    ],
    action: { label: "Open the scope", url: d.scopeUrl },
  };
};
