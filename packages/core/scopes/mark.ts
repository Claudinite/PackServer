/** What a scope has proven. Only the proof appears in the mark; the Verified Publisher label is the hover's. */
export interface MarkFacts {
  verified_domain: string | null;
  verified_github_org: string | null;
  verified_publisher?: boolean;
}

export interface PublisherMark {
  kind: "domain" | "github" | "unproven";
  glyph: "●" | "○";
  /** `acme.com`, `github.com/acme` or `Unproven`. */
  proof: string;
  /** The text a surface prints. */
  text: string;
  /** The Verified Publisher label, present only for a scope that holds it. */
  hover_label: "Verified Publisher" | null;
}

/** A domain proof outranks a GitHub proof when a scope holds both. */
export function publisherMark(facts: MarkFacts): PublisherMark {
  const label = facts.verified_publisher ? "Verified Publisher" : null;
  if (facts.verified_domain) return { kind: "domain", glyph: "●", proof: facts.verified_domain, text: `● ${facts.verified_domain}`, hover_label: label };
  if (facts.verified_github_org) {
    const proof = `github.com/${facts.verified_github_org}`;
    return { kind: "github", glyph: "●", proof, text: `● ${proof}`, hover_label: label };
  }
  return { kind: "unproven", glyph: "○", proof: "Unproven", text: "○ Unproven", hover_label: null };
}
