import type { z } from "zod";
import type { TreeFetchRequest as TreeFetchRequestSchema, TreeFetchResponse as TreeFetchResponseSchema } from "@packserver/schema";
import { buildTree, treeHash } from "../canonical/tree.ts";
import { LIMITS } from "../canonical/limits.ts";
import { GithubUnreachable, type GithubReader } from "./reader.ts";

/** The canonical archive's byte limits, with a file count that fits the Worker's subrequest budget (one request per file). */
export const TREE_LIMITS = {
  files: 800,
  totalBytes: LIMITS.totalUnpackedBytes,
  fileBytes: LIMITS.fileBytes,
  concurrency: 8,
  deadlineMs: 25_000,
  retryAfterS: 30,
} as const;

type TreeFetchRequest = z.infer<typeof TreeFetchRequestSchema>;
type TreeFetchResponse = z.infer<typeof TreeFetchResponseSchema>;
type TreeLimits = { [K in keyof typeof TREE_LIMITS]: number };

const REGULAR = new Set(["100644", "100755"]);

/** `.` is the repository root; anything that climbs out of the repository is no path at all. */
function prefixOf(path: string): string | null {
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  return parts.includes("..") ? null : parts.join("/");
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const at = next++;
        out[at] = await run(items[at]!);
      }
    }),
  );
  return out;
}

/**
 * The tree hash of `path` at `commit` in a public repository, over exactly the regular files
 * under it. A private repository, a path outside the repository, a symlink or submodule, and any
 * tree over the limits answer `not_found`: there is nothing here the registry would verify.
 */
export async function fetchSourceTree(
  makeReader: (signal: AbortSignal) => GithubReader,
  request: TreeFetchRequest,
  limits: TreeLimits = TREE_LIMITS,
): Promise<TreeFetchResponse> {
  const prefix = prefixOf(request.path);
  if (prefix === null) return { status: "not_found" };
  const signal = AbortSignal.timeout(limits.deadlineMs);
  try {
    const reader = makeReader(signal);
    const repo = await reader.getRepoById(request.repository_id);
    if (!repo || repo.private) return { status: "not_found" };
    const listing = await reader.getTreeRecursive(repo.slug, request.commit);
    if (!listing || listing.truncated) return { status: "not_found" };

    const under = listing.entries.filter((e) => prefix === "" || e.path.startsWith(`${prefix}/`));
    const files = under.filter((e) => e.type === "blob");
    const modes = new Map(files.map((e) => [e.path, e.mode]));
    if (files.length === 0 || files.length > limits.files || files.some((e) => !REGULAR.has(e.mode))) return { status: "not_found" };
    const sizes = files.map((e) => e.size ?? Number.POSITIVE_INFINITY);
    if (sizes.some((s) => s > limits.fileBytes) || sizes.reduce((a, b) => a + b, 0) > limits.totalBytes) return { status: "not_found" };

    const strip = prefix === "" ? 0 : prefix.length + 1;
    let fetched = 0;
    const contents = await inBatches(files, limits.concurrency, async (entry) => {
      const content = await reader.getBlob(repo.slug, entry.sha);
      if (!content) throw new GithubUnreachable(`blob ${entry.sha} is missing`);
      fetched += content.length;
      if (content.length > limits.fileBytes || fetched > limits.totalBytes) throw new TooLarge();
      return { path: entry.path.slice(strip), executable: modes.get(entry.path) === "100755", content };
    });
    return { status: "found", tree_hash: treeHash(buildTree(contents)), file_count: contents.length };
  } catch (error) {
    if (error instanceof TooLarge) return { status: "not_found" };
    if (error instanceof GithubUnreachable) return { status: "unreachable", retry_after_s: error.retryAfterS ?? limits.retryAfterS };
    if (signal.aborted) return { status: "unreachable", retry_after_s: limits.retryAfterS };
    throw error;
  }
}

class TooLarge extends Error {}
