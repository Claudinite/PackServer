import { buildTree, type Tree } from "../../canonical/index.ts";
import { findingFactory } from "../engine/rules.ts";
import { loadRules } from "@packserver/rules";
import type { StaticRuleInput, StaticRulePorts } from "../engine/types.ts";

export const RULES_VERSION = "2026.10.1";
export const make = findingFactory(loadRules(RULES_VERSION));

const enc = new TextEncoder();

export function treeOf(files: Record<string, string | Uint8Array>): Tree {
  return buildTree(Object.entries(files).map(([path, c]) => ({ path, executable: false, content: typeof c === "string" ? enc.encode(c) : c })));
}

export const manifestJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: "1.0.0", minEngineVersion: "1.61001.1", license: "MIT", ...over }, null, 2) + "\n";

/** A clean pack: nothing in it should draw a finding. */
export function cleanFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "pack.json": manifestJson(),
    "README.md": "# gcp\n\nNotes for working with Google Cloud.\n",
    "RULES.md": "# Rules\n\n- Prefer small changes.\n",
    "fixtures/example.md": "An example.\n",
    ...extra,
  };
}

export function fakePorts(over: Partial<StaticRulePorts> & { readable?: string[] } = {}): StaticRulePorts {
  return {
    popularPacks: async () => ["@acme/gcp", "@acme/terraform-tips"],
    verifiedScopes: async () => ["acme", "claudinite"],
    provenDomainLabels: async () => [{ label: "acme", scope: "acme" }],
    canRead: async (name) => (over.readable ?? ["@acme/gcp"]).includes(name),
    ...over,
  };
}

export function input(files: Record<string, string | Uint8Array>, over: Partial<StaticRuleInput> = {}): StaticRuleInput {
  return { tree: treeOf(files), pack: "@z/notes", newestVersion: null, rulesVersion: RULES_VERSION, ...over };
}
