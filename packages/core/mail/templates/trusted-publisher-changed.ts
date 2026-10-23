import type { Notice } from "../notice";

/** REQ-PUB-002: sent to every owner of the pack. */
export interface TrustedPublisherChanged {
  pack: string;
  change: "added" | "changed";
  publisher: string;
  actor: string;
  packUrl: string;
}

export const trustedPublisherChanged = (d: TrustedPublisherChanged): Notice => ({
  subject: `Trusted publisher ${d.change} for ${d.pack}`,
  paragraphs: [
    `${d.actor} ${d.change} the trusted publisher of ${d.pack}: ${d.publisher}.`,
    "Only workflows from a trusted publisher can publish this pack from CI. If you did not expect this, review the pack's owners and publishers.",
  ],
  action: { label: "Review the pack", url: d.packUrl },
});
