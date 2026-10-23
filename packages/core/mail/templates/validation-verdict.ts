import type { Finding } from "@packserver/schema";
import type { Notice } from "../notice";

/** REQ-PUB-033 */
export interface ValidationVerdict {
  pack: string;
  version: string;
  verdict: "approved" | "awaiting_approval" | "under_review" | "failed";
  findings: Finding[];
  runUrl: string;
}

const HEADLINE: Record<ValidationVerdict["verdict"], string> = {
  approved: "passed validation",
  awaiting_approval: "passed validation and awaits your approval",
  under_review: "is under review",
  failed: "failed validation",
};

const location = (f: Finding) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : "");

export const validationVerdict = (d: ValidationVerdict): Notice => ({
  subject: `${d.pack} ${d.version} ${HEADLINE[d.verdict]}`,
  paragraphs: [
    `${d.pack} ${d.version} ${HEADLINE[d.verdict]}.`,
    ...(d.findings.length ? ["Findings:", ...d.findings.map((f) => `${location(f)}${f.hint}`)] : []),
  ],
  action: { label: "See the run", url: d.runUrl },
});
