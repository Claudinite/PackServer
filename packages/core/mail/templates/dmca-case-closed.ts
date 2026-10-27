import type { Notice } from "../notice";

/** REQ-MOD-018: a copyright case an admin closed, and what it means for the version. */
export interface DmcaCaseClosed {
  pack: string;
  version: string;
  /** Why the case closed, as a sentence fragment. */
  because: string;
  url: string;
}

export const dmcaCaseClosed = (d: DmcaCaseClosed): Notice => ({
  subject: `Copyright case closed for ${d.pack} ${d.version}`,
  paragraphs: [`The copyright case on ${d.pack} ${d.version} is closed because ${d.because}.`, "The removal is lifted; the version is back where it was before the notice."],
  action: { label: "Open the pack", url: d.url },
});
