import type { Notice } from "../notice";

/** REQ-ACC-015 */
export interface RecoveryApproved {
  signInUrl: string;
}

export const recoveryApproved = (d: RecoveryApproved): Notice => ({
  subject: "Your Claudinite Packs account recovery was approved",
  paragraphs: [
    "An admin approved the recovery of your account. Use the link once, within 24 hours, to sign in and enrol a new passkey.",
  ],
  action: { label: "Sign in and enrol a passkey", url: d.signInUrl },
});
