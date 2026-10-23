import type { Provenance } from "@packserver/schema";
import type { Outcome } from "./types.ts";

export function source(provenance: Provenance): Outcome[] {
  const trusted = provenance.source === "oidc";
  const outcome = (id: string, earned: boolean, detail: string): Outcome => ({ id, ratio: earned ? 1 : 0, violations: earned ? [] : [{ file: null, detail }] });
  return [
    outcome("source.tree-matches-path", provenance.source_verified, "the registry has not verified the tree against the repository path"),
    outcome("source.commit-bound", trusted, "the version is not bound to a commit"),
    outcome("source.trusted-publishing", trusted, "the version was not published by trusted publishing"),
  ];
}
