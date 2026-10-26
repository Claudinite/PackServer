import type { Notice } from "../notice";

/** REQ-SCOPE-011: a domain owner's proof matches this scope's name; the name is held or marked, never taken. */
export interface ScopeNameDisputed {
  scope: string;
  domain: string;
  /** A scope with no promoted public version cannot publish until an admin decides; one with versions keeps publishing. */
  held: boolean;
  scopeUrl: string;
}

export const scopeNameDisputed = (d: ScopeNameDisputed): Notice => ({
  subject: `The name ${d.scope} is disputed`,
  paragraphs: [
    `The owner of ${d.domain} has proven that domain, and its name matches ${d.scope}.`,
    d.held
      ? `${d.scope} has no promoted public version, so it cannot publish until an admin decides the dispute.`
      : `${d.scope} has promoted versions, so it keeps its name and its packs; a disputed notice is shown on its profile.`,
    "Prove a domain or GitHub organisation for the scope to show who stands behind it.",
  ],
  action: { label: "Open the scope", url: d.scopeUrl },
});
