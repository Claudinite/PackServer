import type { Notice } from "../notice";

/** REQ-ACC-005: sent to every verified address of a publishing-capable account. */
export interface FactorAdded {
  factor: string;
  securityUrl: string;
  /** True when the account is publishing-capable and the enrolment was not confirmed by an existing passkey. */
  lockApplies: boolean;
}

export const factorAdded = (d: FactorAdded): Notice => ({
  subject: "A new sign-in factor was added to your account",
  paragraphs: [
    `A new ${d.factor} was added to your Claudinite Packs account.`,
    ...(d.lockApplies
      ? ["For 24 hours it cannot authorise a publish approval, owner change, trusted-publisher change or allowlist change."]
      : []),
    "If this was not you, remove the factor and regenerate your recovery codes now.",
  ],
  action: { label: "Review your security settings", url: d.securityUrl },
});
