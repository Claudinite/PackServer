import { loadRules, RULES_VERSIONS } from "@packserver/rules";
import { buildTree } from "../canonical/index.ts";
import { applyThresholds, checkText, chunkFiles, findingFactory, staticOnly } from "../validation/index.ts";

const COMMENT_FILE = "comment.md";

/**
 * Whether a comment is withheld from everyone but its author. The verdict is the one publisher prose gets: a `ProseScreen`
 * result compared with the rules version's thresholds by `applyThresholds`. Today the screen is `staticOnly` over the
 * text checks (secrets, hidden Unicode, injection, URLs); a model implementation that replaces it for publisher prose
 * covers comments through the same call. A finding the rules class `warn` lets the comment through.
 *
 * Nothing releases a held comment yet; its moderation belongs to the abuse and moderation task (T-093).
 */
export async function isHeldComment(body: string): Promise<boolean> {
  const rules = loadRules(RULES_VERSIONS[RULES_VERSIONS.length - 1]!);
  const make = findingFactory(rules);
  const tree = buildTree([{ path: COMMENT_FILE, executable: false, content: new TextEncoder().encode(body) }]);
  const chunks = chunkFiles([{ path: COMMENT_FILE, text: body }]);
  const result = await staticOnly(checkText(tree, make).findings).screen(chunks, rules.questions.version);
  return applyThresholds(result, chunks, rules, make).findings.some((f) => f.class !== "warn");
}
