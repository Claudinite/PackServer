import type { Notice } from "../notice";

/** REQ-ACC-020 */
export interface ProviderLinked {
  provider: string;
  securityUrl: string;
}

export const providerLinked = (d: ProviderLinked): Notice => ({
  subject: "A sign-in method was linked to your Claudinite Packs account",
  paragraphs: [`${d.provider} can now sign in to your account. If this was not you, review your account at once.`],
  action: { label: "Review your account", url: d.securityUrl },
});
