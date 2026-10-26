import type { Notice } from "../notice";

/** REQ-SCOPE-007: the scope that held a domain proof is told when the domain's record now names another scope. */
export interface DomainProofMoved {
  scope: string;
  domain: string;
  scopeUrl: string;
}

export const domainProofMoved = (d: DomainProofMoved): Notice => ({
  subject: `${d.domain} is no longer verified for ${d.scope}`,
  paragraphs: [
    `The challenge record for ${d.domain} now names a different scope, so the domain proof moved there. ${d.scope} keeps its name, packs, people and history.`,
    "If this was not expected, check who can edit the DNS records or the site for the domain. To take the proof back, start a new proof for the domain.",
  ],
  action: { label: "Open the scope", url: d.scopeUrl },
});
