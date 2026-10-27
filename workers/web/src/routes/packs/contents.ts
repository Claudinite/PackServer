import { buildListing, CACHE_PRIVATE, isPublishedState, parseVersionRow, viewCacheControl, type VersionRow } from "@packserver/core/catalog";
import { PackName, PackVersion } from "@packserver/schema";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { runtimeOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

/** What the validator publishes beside `meta.json`: the README and every file of the version as text. */
export const CONTENTS_FILE = "contents.json";

export const ContentsDocument = z.object({
  readme: z.string().nullable(),
  files: z.array(z.object({ path: z.string().min(1), text: z.string() })),
});
export type ContentsDocument = z.infer<typeof ContentsDocument>;

export const CONTENT_PARTS = ["docs", "manifest", "rules", "skills", "checks", "guards", "tasks", "other"] as const;
export type ContentPart = (typeof CONTENT_PARTS)[number];

/** The part a file belongs to, by where it sits in the pack. */
export function partOf(path: string): ContentPart {
  const top = path.split("/")[0] ?? "";
  if (path === "README.md") return "docs";
  if (path === "pack.json") return "manifest";
  if (path === "RULES.md" || top === "rules") return "rules";
  if (top === "skills") return "skills";
  if (path === "declared-checks.json" || top === "checks") return "checks";
  if (top === "guards") return "guards";
  if (top === "tasks") return "tasks";
  return "other";
}

export interface PackContents {
  pack: string;
  version: string;
  readme: string | null;
  files: Array<{ path: string; part: ContentPart; text: string }>;
}

export type ContentsRead = { kind: "found"; contents: PackContents } | { kind: "unavailable" };

/** An absent or malformed object is `unavailable`, never an empty pack. */
export async function readContents(c: Context<WebEnv>, pack: string, version: string): Promise<ContentsRead> {
  const body = await runtimeOf(c).ports.r2.PACKS_PUBLIC?.get(`${pack}/${version}/${CONTENTS_FILE}`);
  if (!body) return { kind: "unavailable" };
  try {
    const parsed = ContentsDocument.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success) return { kind: "unavailable" };
    const order = (p: ContentPart) => CONTENT_PARTS.indexOf(p);
    const files = parsed.data.files.map((f) => ({ ...f, part: partOf(f.path) })).sort((a, b) => order(a.part) - order(b.part) || a.path.localeCompare(b.path));
    return { kind: "found", contents: { pack, version, readme: parsed.data.readme, files } };
  } catch {
    return { kind: "unavailable" };
  }
}

export const READABLE: readonly string[] = ["active", "deprecated", "yanked"];

/** The one gate for a version's files and README, on the page and in the API: only the states whose bytes a resolver hands out. */
export const isReadable = (state: string): boolean => READABLE.includes(state);

const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": CACHE_PRIVATE } });

routes.get("/packs/:scope/:name/contents", async (c) => {
  const scope = c.req.param("scope");
  const name = `${scope}/${c.req.param("name")}`;
  if (!PackName.safeParse(name).success) return notFound();
  const asked = c.req.query("version");
  if (asked !== undefined && !PackVersion.safeParse(asked).success) return notFound();

  const { d1 } = runtimeOf(c).ports;
  const found = await d1.query(
    "SELECT p.id AS id, p.visibility AS visibility FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ?",
    [scope.slice(1), c.req.param("name")],
  );
  const pack = found.rows[0];
  if (!pack || pack.visibility !== "public") return notFound();
  const result = await d1.query(
    "SELECT version, state, sha256, upload_sha256, size_bytes, published_at, verified, verified_domain, verified_github_org, source_verified, min_engine_version, requires, source_commit, score, report_key FROM pack_versions WHERE pack_id = ?",
    [pack.id],
  );
  const rows: VersionRow[] = result.rows.map(parseVersionRow).filter((r) => isPublishedState(r.state));
  const version = asked ?? buildListing(name, rows, new Map()).latest_eligible;
  const row = rows.find((r) => r.version === version);
  if (!row || !isReadable(row.state)) return notFound();

  const read = await readContents(c, name, row.version);
  if (read.kind === "unavailable") return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": CACHE_PRIVATE } });
  const cache = viewCacheControl({ cookie: c.req.header("cookie") ?? null, authorization: c.req.header("authorization") ?? null });
  return Response.json(read.contents, { headers: { "cache-control": cache } });
});
