import type { Notice } from "../notice";

/** REQ-ACC-014 */
export interface NewDeviceSignIn {
  device: string;
  location: string;
  at: string;
  securityUrl: string;
}

export const newDeviceSignIn = (d: NewDeviceSignIn): Notice => ({
  subject: "New sign-in to your PackServer account",
  paragraphs: [
    `Your account was signed in to from a new device: ${d.device}, ${d.location}, at ${d.at}.`,
    "If this was you, no action is needed. If not, revoke the session and review your factors.",
  ],
  action: { label: "Review sessions", url: d.securityUrl },
});
