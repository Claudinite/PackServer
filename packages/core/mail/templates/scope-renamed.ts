import type { Notice } from "../notice";

/** REQ-SCOPE-011: an admin moved a disputed name to the domain's owner; the previous holder keeps everything under a new name. */
export interface ScopeRenamed {
  /** The name it had, as `@name`. */
  was: string;
  /** The name it has now, as `@name`. */
  now: string;
  scopeUrl: string;
}

export const scopeRenamed = (d: ScopeRenamed): Notice => ({
  subject: `${d.was} is now ${d.now}`,
  paragraphs: [
    `The name ${d.was} was disputed by the owner of a domain that matches it, and an admin moved the name to them. Your scope is now ${d.now}.`,
    "Your packs, people and history are unchanged and your packs are served under the new name. Update anything that refers to the old name.",
  ],
  action: { label: "Open the scope", url: d.scopeUrl },
});
