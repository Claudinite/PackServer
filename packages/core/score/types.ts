import type { Capability, Provenance } from "@packserver/schema";
import type { Tree } from "../canonical/index.ts";

export interface ScoreInput {
  tree: Tree;
  /** The version's capability set; the caller extracts it from the same tree. */
  capabilities: readonly Capability[];
  provenance: Provenance;
  /** Whether the pack is linked to a public source repository. */
  linkedPublicRepository: boolean;
  /** Whether a published advisory stands against the newest eligible version. */
  publishedAdvisory: boolean;
  rulesVersion: string;
}

export interface Loss {
  rule: string;
  file: string | null;
  fix: string;
  /** Points this entry accounts for; the entries of one rule add up to the rule's lost points. */
  points: number;
}

export interface ScoredRule {
  rule: string;
  points: number;
  max: number;
}

export interface ScoredPart {
  part: string;
  weight: number;
  points: number;
  rules: ScoredRule[];
}

export interface ScoreResult {
  rules_version: string;
  /** The sum of the parts after the cap. */
  total: number;
  /** The sum of the parts before any cap. */
  uncapped: number;
  parts: ScoredPart[];
  /** The lowest cap that lowered the score, or null when none did. */
  cap: { reason: string; max: number } | null;
  losses: Loss[];
  markers: string[];
}

/** What one rule found: how much of its weight it earned, and where it lost the rest. */
export interface Outcome {
  id: string;
  /** Share of the rule's maximum earned, 0 to 1; exactly 1 only when `violations` is empty. */
  ratio: number;
  violations: { file: string | null; detail?: string }[];
}
