import { loadRules } from "@packserver/rules";
import type { Meta } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { scorePack, type ScoreResult } from "../../score/index.ts";

/** The score a published version earns under another rules version: the same tree and facts, the new weights. */
export function rescore(input: { tree: Tree; meta: Pick<Meta, "capabilities" | "provenance">; publishedAdvisory: boolean; rulesVersion: string }): ScoreResult {
  loadRules(input.rulesVersion);
  return scorePack({
    tree: input.tree,
    capabilities: input.meta.capabilities,
    provenance: input.meta.provenance,
    linkedPublicRepository: input.meta.provenance.source === "oidc",
    publishedAdvisory: input.publishedAdvisory,
    rulesVersion: input.rulesVersion,
  });
}
