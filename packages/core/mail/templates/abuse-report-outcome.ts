import type { Notice } from "../notice";

/** REQ-MOD-015: the reporter learns what became of the report and nothing else. */
export interface AbuseReportOutcome {
  /** What was reported: a pack name, or the kind of thing for a review or a profile. */
  target: string;
  outcome: "actioned" | "closed";
  url: string;
}

export const abuseReportOutcome = (d: AbuseReportOutcome): Notice => ({
  subject: `Update on your report about ${d.target}`,
  paragraphs: [d.outcome === "actioned" ? `Your report about ${d.target} was acted on.` : `Your report about ${d.target} was reviewed and closed without action.`],
  action: { label: "Open the page", url: d.url },
});
