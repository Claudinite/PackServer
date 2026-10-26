import { VersionsDocument, Meta, PackName } from "@packserver/schema";
import {
  buildListing,
  isPublishedState,
  needsNote,
  objectKey,
  parseVersionRow,
  type PackListing,
  type StatusNote,
  type VersionRow,
} from "@packserver/core/catalog";
import { z } from "zod";
import type { McpRuntime } from "../bindings";
import type { PackRef } from "./extras";

export interface PublicPack extends PackRef {
  rows: VersionRow[];
  notes: Map<string, StatusNote>;
  listing: PackListing;
}

export type PackLookup = { kind: "found"; pack: PublicPack } | { kind: "missing" } | { kind: "unavailable" };

export async function readJson(runtime: McpRuntime, key: string): Promise<unknown | undefined> {
  const body = await runtime.ports.r2.PACKS_PUBLIC?.get(key);
  if (!body) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/** The one answer for a name that is not a pack, a pack that does not exist and one the caller may not know exists. */
export async function findPublicPack(runtime: McpRuntime, name: string): Promise<PackLookup> {
  if (!PackName.safeParse(name).success) return { kind: "missing" };
  const [scope, packName] = name.slice(1).split("/") as [string, string];
  const found = await runtime.ports.d1.query(
    "SELECT p.id AS id, p.visibility AS visibility FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ? AND s.kind <> 'synthetic'",
    [scope, packName],
  );
  const row = found.rows[0];
  if (!row || row.visibility !== "public") return { kind: "missing" };

  const result = await runtime.ports.d1.query(
    "SELECT version, state, sha256, upload_sha256, size_bytes, published_at, verified, verified_domain, verified_github_org, source_verified, min_engine_version, requires, source_commit, score, report_key FROM pack_versions WHERE pack_id = ?",
    [row.id],
  );
  const rows = result.rows.map(parseVersionRow).filter((r) => isPublishedState(r.state));
  if (rows.length === 0) return { kind: "missing" };

  const notes = new Map<string, StatusNote>();
  if (rows.some((r) => needsNote(r.state))) {
    const parsed = VersionsDocument.safeParse(await readJson(runtime, objectKey(name, "versions")));
    if (!parsed.success) return { kind: "unavailable" };
    for (const v of parsed.data.versions) notes.set(v.version, { reason: v.reason, security: v.security });
  }
  return { kind: "found", pack: { id: String(row.id), name, rows, notes, listing: buildListing(name, rows, notes) } };
}

export async function readMeta(runtime: McpRuntime, name: string, version: string): Promise<Meta | undefined> {
  const parsed = Meta.safeParse(await readJson(runtime, objectKey(name, "meta", version)));
  return parsed.success ? parsed.data : undefined;
}

/** What the validator publishes beside `meta.json` for the prose an agent may read: capped again on read. */
const Excerpts = z.object({
  readme: z.string().nullable().optional(),
  rules: z.string().nullable().optional(),
  skills: z.array(z.object({ name: z.string(), description: z.string() })).optional(),
});
export type Excerpts = z.infer<typeof Excerpts>;

export const EXCERPT_LIMIT = 2000;
export const EXCERPTS_FILE = "excerpts.json";

export async function readExcerpts(runtime: McpRuntime, name: string, version: string): Promise<Excerpts | undefined> {
  const parsed = Excerpts.safeParse(await readJson(runtime, `${name}/${version}/${EXCERPTS_FILE}`));
  return parsed.success ? parsed.data : undefined;
}

/** The engine release the `cn_min_adopt_version` flag names; undefined while it is unset. */
export async function adoptVersionFlag(runtime: McpRuntime): Promise<string | undefined> {
  const { rows } = await runtime.ports.d1.query("SELECT value FROM feature_flags WHERE key = 'cn_min_adopt_version'");
  const raw = rows[0]?.value;
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}
