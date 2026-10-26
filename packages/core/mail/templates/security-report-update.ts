import type { Notice } from "../notice";

/** REQ-MOD-002, REQ-MOD-003, REQ-MOD-007: tells registry security, or a pack's security contact, what needs attention. */
export interface SecurityReportUpdate {
  pack: string;
  event: "filed" | "fixed" | "timer_expired";
  severity: string;
  reportUrl: string;
}

const SUBJECT: Record<SecurityReportUpdate["event"], string> = {
  filed: "New security report",
  fixed: "Security report marked fixed",
  timer_expired: "Security report disclosure timer ended",
};

const ACTION: Record<SecurityReportUpdate["event"], string> = {
  filed: "The report is private until an advisory is published.",
  fixed: "The publisher marked it fixed: an advisory naming the affected versions is due.",
  timer_expired: "The 90 days are up: an advisory naming the affected versions is due.",
};

export const securityReportUpdate = (d: SecurityReportUpdate): Notice => ({
  subject: `${SUBJECT[d.event]} on ${d.pack}`,
  paragraphs: [`${SUBJECT[d.event]} on ${d.pack} (severity ${d.severity}).`, ACTION[d.event]],
  action: { label: "Open the report", url: d.reportUrl },
});
