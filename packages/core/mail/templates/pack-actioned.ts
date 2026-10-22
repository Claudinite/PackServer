import type { Notice } from "../notice";

/** REQ-MOD-014: sent to the publisher with the reason and an appeal link. */
export interface PackActioned {
  pack: string;
  action: string;
  reason: string;
  appealUrl: string;
}

export const packActioned = (d: PackActioned): Notice => ({
  subject: `Action taken on ${d.pack}`,
  paragraphs: [
    `${d.pack} was ${d.action}.`,
    `Reason: ${d.reason}`,
    "You can appeal this decision.",
  ],
  action: { label: "Appeal", url: d.appealUrl },
});
