import type { Notice } from "../notice";

/** REQ-ACC-011: sent to every verified address when the fifth failed assertion locks step-up. */
export interface StepUpLocked {
  minutes: number;
  securityUrl: string;
}

export const stepUpLocked = (d: StepUpLocked): Notice => ({
  subject: "Sensitive actions on your account are locked",
  paragraphs: [
    `Five attempts to confirm a sensitive action failed, so sensitive actions on your Claudinite Packs account are locked for ${d.minutes} minutes.`,
    "If this was not you, review your sessions and passkeys once the lock ends.",
  ],
  action: { label: "Review your security settings", url: d.securityUrl },
});
