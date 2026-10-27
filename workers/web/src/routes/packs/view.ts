import { Hono, type Context } from "hono";
import { VersionsDocument, Meta, Attestation, PackName, PackVersion } from "@packserver/schema";
import {
  CACHE_PRIVATE,
  buildListing,
  buildVersionView,
  isPublishedState,
  lookupVersion,
  needsNote,
  objectKey,
  parseVersionRow,
  statusNotesOf,
  summarise,
  viewCacheControl,
  type StatusNote,
  type VersionRow,
} from "@packserver/core/catalog";
import { cdnOriginOf, runtimeOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

const NO_STORE = { "cache-control": CACHE_PRIVATE };

/** The one answer for a pack that does not exist and for one the caller may not know exists. */
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
const unavailable = () => Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });

async function readJson(c: Context<WebEnv>, key: string): Promise<unknown | undefined> {
  const body = await runtimeOf(c).ports.r2.PACKS_PUBLIC?.get(key);
  if (!body) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/** Reasons are in the registry database, written with each status change; the pack's signed history is read only where a row holds none. */
async function readNotes(c: Context<WebEnv>, pack: string, packId: string): Promise<Map<string, StatusNote> | undefined> {
  const recorded = await statusNotesOf(runtimeOf(c).ports.d1, packId);
  if (recorded) return recorded;
  const parsed = VersionsDocument.safeParse(await readJson(c, objectKey(pack, "versions")));
  if (!parsed.success) return undefined;
  return new Map(parsed.data.versions.map((v) => [v.version, { reason: v.reason, security: v.security }]));
}

async function readDetail(c: Context<WebEnv>, pack: string, row: VersionRow, note: StatusNote | undefined) {
  const meta = Meta.safeParse(await readJson(c, objectKey(pack, "meta", row.version)));
  const attestation = Attestation.safeParse(await readJson(c, objectKey(pack, "attestation", row.version)));
  if (!meta.success || !attestation.success) return undefined;
  return buildVersionView({
    pack,
    row,
    ...(note ? { note } : {}),
    meta: meta.data,
    attestation: attestation.data,
    origin: cdnOriginOf(c),
  });
}

async function handle(c: Context<WebEnv>, next: () => Promise<void>): Promise<Response | void> {
  const scope = c.req.param("scope") ?? "";
  const nameOnly = c.req.param("name") ?? "";
  const requested = c.req.param("version");
  const name = `${scope}/${nameOnly}`;
  if (!PackName.safeParse(name).success) return notFound();
  // `/packs/@s/n/<word>` belongs to the routers mounted after this one.
  if (requested !== undefined && !PackVersion.safeParse(requested).success) return next();

  const { d1 } = runtimeOf(c).ports;
  const packs = await d1.query(
    "SELECT p.id AS id, p.visibility AS visibility FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ?",
    [scope.slice(1), nameOnly],
  );
  const pack = packs.rows[0];
  if (!pack || pack.visibility !== "public") return notFound();

  const result = await d1.query(
    "SELECT version, state, sha256, upload_sha256, size_bytes, published_at, verified, verified_domain, verified_github_org, source_verified, min_engine_version, requires, source_commit, score, score_rules_version, score_breakdown, report_key FROM pack_versions WHERE pack_id = ?",
    [pack.id],
  );
  const rows = result.rows.map(parseVersionRow).filter((r) => isPublishedState(r.state));
  if (rows.length === 0) return notFound();

  const missing = requested !== undefined ? lookupVersion(rows, requested) : undefined;
  if (missing?.kind === "missing") return notFound();

  let notes = new Map<string, StatusNote>();
  if (rows.some((r) => needsNote(r.state))) {
    const read = await readNotes(c, name, String(pack.id));
    if (!read) return unavailable();
    notes = read;
  }
  const listing = buildListing(name, rows, notes);
  if (listing.status === "removed") return Response.json(listing, { status: 410, headers: NO_STORE });

  const target = requested ?? listing.latest_eligible;
  if (requested !== undefined) {
    const found = lookupVersion(rows, requested);
    if (found.kind === "removed") {
      const gone = rows.find((r) => r.version === requested);
      return Response.json({ ...listing, version: gone ? summarise(gone) : null }, { status: 410, headers: NO_STORE });
    }
    if (found.kind === "held") {
      const summary = summarise(found.row, notes.get(requested));
      return Response.json({ name, version: requested, status: "quarantined", under_review: true, reason: summary.reason }, { status: 451, headers: NO_STORE });
    }
  }
  const row = target === null || target === undefined ? undefined : rows.find((r) => r.version === target);
  const version = row ? await readDetail(c, name, row, notes.get(row.version)) : null;
  if (version === undefined) return unavailable();
  const cache = viewCacheControl({ cookie: c.req.header("cookie") ?? null, authorization: c.req.header("authorization") ?? null });
  return Response.json({ ...listing, version }, { headers: { "cache-control": cache } });
}

routes.get("/packs/:scope/:name", handle);
routes.get("/packs/:scope/:name/:version", handle);
