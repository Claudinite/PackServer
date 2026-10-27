import type { Notice } from "../notice";

/** REQ-MOD-018: the complainant's copy of a counter-notice, with the date the version returns. */
export interface DmcaCounterNotice {
  pack: string;
  version: string;
  notice: string;
  /** Business days after which the version is restored unless a suit is notified. */
  restoreAfterBusinessDays: number;
  url: string;
}

export const dmcaCounterNotice = (d: DmcaCounterNotice): Notice => ({
  subject: `Counter-notice for ${d.pack} ${d.version}`,
  paragraphs: [
    `The publisher of ${d.pack} ${d.version} filed a counter-notice against the removal you requested:`,
    d.notice,
    `The version is restored ${d.restoreAfterBusinessDays} business days after the counter-notice unless you tell us before then that you have filed an action seeking a court order against the publisher.`,
  ],
  action: { label: "Open the pack", url: d.url },
});
