import type { Notice } from "../notice";

/** REQ-PUB-033 */
export interface ValidationVerdict {
  pack: string;
  version: string;
  verdict: "approved" | "awaiting_approval" | "under_review" | "failed";
  findings: Array<{ file: string; line: number; message: string }>;
  runUrl: string;
}

const HEADLINE: Record<ValidationVerdict["verdict"], string> = {
  approved: "passed validation",
  awaiting_approval: "passed validation and awaits your approval",
  under_review: "is under review",
  failed: "failed validation",
};

export const validationVerdict = (d: ValidationVerdict): Notice => ({
  subject: `${d.pack} ${d.version} ${HEADLINE[d.verdict]}`,
  paragraphs: [
    `${d.pack} ${d.version} ${HEADLINE[d.verdict]}.`,
    ...(d.findings.length ? ["Findings:", ...d.findings.map((f) => `${f.file}:${f.line} ${f.message}`)] : []),
  ],
  action: { label: "See the run", url: d.runUrl },
});
