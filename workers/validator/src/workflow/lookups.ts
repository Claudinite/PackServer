import { compareVersions } from "@packserver/core/index";
import { objectKey } from "@packserver/core/catalog";
import type { SandboxARequest } from "@packserver/core/validation";
import { Meta } from "@packserver/schema";
import type { D1, R2Read } from "@packserver/ports";
import { packId, type RunInput } from "./run";

const POPULAR_LIMIT = 1_000;

const names = (rows: Array<Record<string, unknown>>): string[] => rows.map((r) => `@${String(r.scope)}/${String(r.name)}`);

/**
 * What sandbox A cannot look up for itself, read once for this run. A pack that exists but the
 * principal may not read is left out of `readable_packs`, so it answers exactly as a pack that
 * does not exist.
 */
export async function lookupsFor(d1: D1, run: RunInput): Promise<SandboxARequest["lookups"]> {
  const popular = await d1.query(
    `select s.name as scope, p.name as name from packs p join scopes s on s.id = p.scope_id
      where p.visibility = 'public' and exists (select 1 from pack_versions v where v.pack_id = p.id and v.published_at is not null)
      order by p.created_at limit ?`,
    [POPULAR_LIMIT],
  );
  const scopes = await d1.query(`select name, verified_domain, verified_github_org from scopes where verified_domain is not null or verified_github_org is not null`);
  const userId = run.principal.startsWith("user:") ? run.principal.slice("user:".length) : null;
  const readable = await d1.query(
    `select s.name as scope, p.name as name from packs p join scopes s on s.id = p.scope_id
      where exists (select 1 from pack_versions v where v.pack_id = p.id and v.published_at is not null)
        and (p.visibility = 'public' or p.scope_id = ? or (? is not null and exists (select 1 from scope_members m where m.scope_id = p.scope_id and m.user_id = ?)))`,
    [run.scope_id, userId, userId],
  );
  return {
    popular_packs: names(popular.rows),
    verified_scopes: scopes.rows.map((r) => String(r.name)),
    proven_domain_labels: scopes.rows
      .filter((r) => typeof r.verified_domain === "string")
      .map((r) => ({ label: String(r.verified_domain).split(".")[0]!, scope: String(r.name) })),
    readable_packs: names(readable.rows),
  };
}

/** The newest version the pack already has published, whichever status it has since taken. */
export async function newestPublished(d1: D1, run: RunInput): Promise<string | null> {
  const rows = (
    await d1.query(
      `select v.version from pack_versions v join packs p on p.id = v.pack_id where p.scope_id = ? and p.name = ? and v.published_at is not null`,
      [run.scope_id, run.pack_name],
    )
  ).rows;
  const versions = rows.map((r) => String(r.version)).sort(compareVersions);
  return versions.at(-1) ?? null;
}

/** The previous version's capabilities and pre-install manifest, as its `meta.json` stored them; null for a first version. */
export async function previousPromoted(d1: D1, buckets: { public: R2Read; private: R2Read }, run: RunInput, newest: string | null): Promise<unknown> {
  if (newest === null) return null;
  const visibility = String((await d1.query(`select visibility from packs where scope_id = ? and name = ?`, [run.scope_id, run.pack_name])).rows[0]?.visibility);
  const bytes = await (visibility === "private" ? buckets.private : buckets.public).get(objectKey(packId(run), "meta", newest));
  if (!bytes) return null;
  const meta = Meta.pick({ capabilities: true, preinstall: true }).safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  return meta.success ? meta.data : null;
}
