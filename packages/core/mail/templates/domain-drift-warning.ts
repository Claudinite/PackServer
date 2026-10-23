import type { Notice } from "../notice";

/** REQ-VAL-018: a drifted URL in ordinary prose is a warning, not a quarantine. */
export interface DomainDriftWarning {
  pack: string;
  version: string;
  domain: string;
  versionUrl: string;
}

export const domainDriftWarning = (d: DomainDriftWarning): Notice => ({
  subject: `A link in ${d.pack} ${d.version} now resolves differently`,
  paragraphs: [
    `The domain ${d.domain}, linked from the prose of ${d.pack} ${d.version}, now resolves differently from when the version was validated.`,
    "The version stays available with a warning. Check that you still control the link.",
  ],
  action: { label: "Open the version", url: d.versionUrl },
});
