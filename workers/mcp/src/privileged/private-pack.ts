import type { Caller as AccessCaller } from "@packserver/core/access";
import type { McpRuntime } from "../bindings";
import type { Caller } from "../limits";
import { findReadablePrivatePack, versionsOf, type PrivatePack } from "../tools/catalog";
import { answer, failure } from "../tools/result";
import { lookupVersion } from "@packserver/core/catalog";

/** A private pack has no public `meta.json`: the view is what the registry's own tables say, and nothing a publisher wrote beyond the pitch. */
export async function privatePackView(runtime: McpRuntime, name: string, version: string | undefined, access: AccessCaller) {
  const found = await findReadablePrivatePack(runtime, name, access);
  if (found.kind === "missing") return failure("not_found", "No pack you can read has that name.");
  const pack: PrivatePack = found.pack;
  if (pack.listing.status === "removed") return failure("removed", "That pack has been removed.");
  if (version !== undefined) {
    const lookup = lookupVersion(pack.rows, version);
    if (lookup.kind === "missing") return failure("not_found", "That pack has no such version.");
    if (lookup.kind === "removed") return failure("removed", "That version has been removed.");
    if (lookup.kind === "held") return answer({ id: pack.name, version, status: "quarantined", under_review: true });
  }
  const target = version ?? pack.listing.latest_eligible;
  const row = pack.rows.find((r) => r.version === target);
  const listed = (await runtime.ports.d1.query("SELECT pitch, category, tags FROM pack_search WHERE pack_id = ?", [pack.id])).rows[0];
  return answer({
    id: pack.name,
    visibility: "private",
    status: pack.listing.status,
    latest_eligible: pack.listing.latest_eligible,
    ...(row
      ? {
          version: row.version,
          published_at: row.published_at,
          min_engine_version: row.min_engine_version,
          verification: { verified: row.verified, verified_domain: row.verified_domain, verified_github_org: row.verified_github_org, source_verified: row.source_verified },
          score: { total: row.score },
        }
      : {}),
    category: typeof listed?.category === "string" ? listed.category : null,
    publisher_text: {
      pitch: typeof listed?.pitch === "string" ? listed.pitch : null,
      tags: typeof listed?.tags === "string" ? listed.tags.split(" ").filter(Boolean) : [],
    },
    versions: versionsOf(pack),
  });
}

/**
 * Where a credential fetches a private version. The bytes are served by the site under the same credential, so only
 * a `psr_` read token can follow the link; an OAuth grant is told so rather than sent to a 401.
 */
export async function privateDownload(runtime: McpRuntime, caller: Caller, access: AccessCaller, name: string, version: string | undefined) {
  const found = await findReadablePrivatePack(runtime, name, access);
  if (found.kind === "missing") return failure("not_found", "No pack you can read has that name.");
  const { pack } = found;
  if (pack.listing.status === "removed") return failure("removed", "That pack has been removed.");
  const target = version ?? pack.listing.latest_eligible;
  if (target === null) return failure("not_resolved", "No version of that pack is eligible. Name an exact version to resolve a yanked one.");
  const lookup = lookupVersion(pack.rows, target);
  if (lookup.kind === "missing") return failure("not_found", "That pack has no such version.");
  if (lookup.kind === "removed") return failure("removed", "That version has been removed.");
  if (lookup.kind === "held") return answer({ id: name, version: target, status: "quarantined", under_review: true });
  if (caller.kind !== "token") return failure("private_download_needs_token", "Private archives are fetched with a psr_ read token; an OAuth connection can read about the pack but not download it.");

  const id = (await runtime.ports.d1.query("SELECT id FROM pack_versions WHERE pack_id = ? AND version = ?", [pack.id, target])).rows[0]?.id;
  if (typeof id !== "string") return failure("not_found", "That pack has no such version.");
  return answer({
    id: name,
    version: target,
    status: lookup.status,
    url: `${new URL(runtime.config.resource).origin}/api/private/v/${id}`,
    sha256: lookup.row.sha256,
    requires_bearer: true,
    ...(lookup.status === "yanked" ? { yanked: true } : {}),
  });
}
