import type { Notice } from "../notice";

/** REQ-MOD-006: sent to the reporter on each status change. */
export interface ReportStatusChanged {
  pack: string;
  status: "open" | "acknowledged" | "fixed" | "wont_fix" | "duplicate";
  fixedIn: string | null;
  reportUrl: string;
}

const LABEL: Record<ReportStatusChanged["status"], string> = {
  open: "open",
  acknowledged: "acknowledged",
  fixed: "fixed",
  wont_fix: "marked won't fix",
  duplicate: "marked as a duplicate",
};

export const reportStatusChanged = (d: ReportStatusChanged): Notice => ({
  subject: `Your report on ${d.pack} is ${LABEL[d.status]}`,
  paragraphs: [
    `The publisher set your report on ${d.pack} to: ${LABEL[d.status]}.`,
    ...(d.status === "fixed" && d.fixedIn ? [`Fixed in ${d.fixedIn}.`] : []),
  ],
  action: { label: "Open the report", url: d.reportUrl },
});
