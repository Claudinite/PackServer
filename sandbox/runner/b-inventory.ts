import type { Tree } from "@packserver/core/canonical";
import { B_LIMITS } from "./b-limits.ts";
import type { SandboxBReport } from "./b-report.ts";

type Kind = SandboxBReport["inventory"][number]["kind"];

export function kindOf(path: string): Kind {
  if (path === "pack.json") return "manifest";
  if (path === "RULES.md") return "rules";
  if (/^skills\/[^/]+\/SKILL\.md$/.test(path)) return "skill";
  if (/^checks\/[^/]+\.go$/.test(path)) return "check";
  if (/(^|\/)declared-checks\.json$/.test(path)) return "declared_check";
  if (/^tasks\/[^/]+\/task\.json$/.test(path)) return "task";
  if (/^tasks\/[^/]+\/worker\.mjs$/.test(path)) return "worker";
  if (/\.md$/.test(path)) return "doc";
  return "other";
}

const PROSE: ReadonlySet<Kind> = new Set(["rules", "skill", "doc"]);

/** Token counts are an estimate (a quarter of the byte length) until the engine exposes its own counter. */
export function inventoryOf(tree: Tree): Pick<SandboxBReport, "inventory" | "inventory_total" | "inventory_truncated" | "token_counts"> {
  const all = tree.files.map((f) => {
    const kind = kindOf(f.path);
    return { path: f.path, kind, bytes: f.size, tokens: PROSE.has(kind) ? Math.ceil(f.size / 4) : null };
  });
  const total = all.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
  return {
    inventory: all.slice(0, B_LIMITS.inventory),
    inventory_total: all.length,
    inventory_truncated: all.length > B_LIMITS.inventory,
    token_counts: { total, method: "bytes/4" },
  };
}
