import type { Notice } from "../notice";

/** REQ-COMM-012: sent to the author of a review a moderator removed, with the reason. */
export interface ReviewRemoved {
  pack: string;
  reason: string;
  packUrl: string;
}

export const reviewRemoved = (d: ReviewRemoved): Notice => ({
  subject: `Your review of ${d.pack} was removed`,
  paragraphs: [`A moderator removed your review of ${d.pack}.`, `Reason: ${d.reason}`],
  action: { label: "Open the pack", url: d.packUrl },
});
