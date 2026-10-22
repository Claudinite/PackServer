import type { Notice } from "../notice";

/** REQ-PUB-035: sent to every owner on every promotion; cannot be turned off. */
export interface VersionPublished {
  pack: string;
  version: string;
  path: string;
  actor: string;
  versionUrl: string;
}

export const versionPublished = (d: VersionPublished): Notice => ({
  subject: `${d.pack} ${d.version} was published`,
  paragraphs: [
    `${d.pack} ${d.version} was published by ${d.actor} through ${d.path}.`,
    "Every publish is reported to every owner. If you do not recognise it, yank the version and review your tokens and trusted publishers.",
  ],
  action: { label: "Open the version", url: d.versionUrl },
});
