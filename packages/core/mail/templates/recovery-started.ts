import type { Notice } from "../notice";

/** REQ-ACC-015 */
export interface RecoveryStarted {
  hours: number;
  securityUrl: string;
  /** One-time link that stops the recovery. */
  cancelUrl: string;
}

export const recoveryStarted = (d: RecoveryStarted): Notice => ({
  subject: "Account recovery requested for your Claudinite Packs account",
  paragraphs: [
    `Someone asked to recover this account, which has no passkey or linked sign-in left. An admin reviews every such request and none completes sooner than ${d.hours} hours from now. Publishing for the account's packs is paused until it is resolved.`,
    "If this was you, no action is needed. If it was not, use the link below to stop the recovery; signing in and adding a passkey or a linked sign-in also stops it.",
  ],
  action: { label: "Stop this recovery", url: d.cancelUrl },
  links: [{ label: "Review your account", url: d.securityUrl }],
});
