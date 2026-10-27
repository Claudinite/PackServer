import { loadRules, RULES_VERSIONS } from "@packserver/rules";
import { buildTree } from "../canonical/index.ts";
import { checkText, findingFactory } from "../validation/index.ts";

const COMMENT_FILE = "comment.md";

/**
 * Whether a comment is held for a moderator. It goes through the same text checks as publisher prose (secrets, hidden
 * Unicode, injection and URL rules), the static prose screen the registry launches with; nothing reads it with a model.
 * A finding the rules class `warn` lets the comment through.
 */
export function heldByTextChecks(body: string): boolean {
  const make = findingFactory(loadRules(RULES_VERSIONS[RULES_VERSIONS.length - 1]!));
  const tree = buildTree([{ path: COMMENT_FILE, executable: false, content: new TextEncoder().encode(body) }]);
  return checkText(tree, make).findings.some((f) => f.class !== "warn");
}
