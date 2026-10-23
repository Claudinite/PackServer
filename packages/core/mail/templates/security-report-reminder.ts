import type { Notice } from "../notice";

/** REQ-MOD-002: sent to a pack's owners 7 days before a security report's disclosure timer ends. */
export interface SecurityReportReminder {
  pack: string;
  deadline: string;
  reportUrl: string;
}

export const securityReportReminder = (d: SecurityReportReminder): Notice => ({
  subject: `A security report on ${d.pack} is disclosed in 7 days`,
  paragraphs: [
    `A security report on ${d.pack} reaches its 90-day disclosure date on ${d.deadline.slice(0, 10)}.`,
    "Fix and release it before then, or registry security publishes an advisory naming the affected versions.",
  ],
  action: { label: "Open the report", url: d.reportUrl },
});
