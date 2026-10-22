import type { Notice } from "../notice";

/** REQ-ACC-005: sent to every verified address of a publishing-capable account. */
export interface FactorAdded {
  factor: string;
  securityUrl: string;
  holdHours: number;
}

export const factorAdded = (d: FactorAdded): Notice => ({
  subject: "A new sign-in factor was added to your account",
  paragraphs: [
    `A new ${d.factor} was added to your PackServer account.`,
    `For ${d.holdHours} hours it cannot authorise a publish approval, owner change, trusted-publisher change or allowlist change, unless an existing passkey confirmed the enrolment.`,
    "If this was not you, remove the factor and regenerate your recovery codes now.",
  ],
  action: { label: "Review your security settings", url: d.securityUrl },
});
