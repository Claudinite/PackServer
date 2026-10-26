import { lookupVersion, summarise, type VersionRow } from "@packserver/core/catalog";
import { StoredCard } from "@packserver/core/search";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpRuntime } from "../bindings";
import { adoptVersionFlag, EXCERPT_LIMIT, findPublicPack, readExcerpts, readMeta, type PublicPack } from "./catalog";
import type { Advisory, PackExtras } from "./extras";
import { answer, describe, failure, unavailable } from "./result";

export const REPORTED_LABEL = "Reported, under review";

/** Until the flag names a released engine there is nothing to adopt with: the answer says so instead of a command. */
export function adoptSnippets(name: string, flag: string | undefined, minEngine: string | null) {
  if (flag === undefined) return { adopt_snippet: `Preview: adoptable with cn ≥ ${minEngine ?? "the engine release that ships adoption"}` };
  return { adopt_snippet: `cn adopt ${name}`, declared_snippet: `packs.declared: ["${name}"]` };
}

const advisoryOf = (a: Advisory) => ({ version: a.version, severity: a.severity, id: a.id, publisher_text: { summary: a.summary } });

async function searchRow(runtime: McpRuntime, packId: string) {
  const { rows } = await runtime.ports.d1.query(
    `SELECT ps.pitch AS pitch, ps.category AS category, ps.tags AS tags, ps.card AS card, st.stars AS stars, st.fetches_30d AS fetches_30d, st.rating AS rating
FROM pack_search ps LEFT JOIN pack_stats st ON st.pack_id = ps.pack_id WHERE ps.pack_id = ?`,
    [packId],
  );
  return rows[0];
}

function versionsOf(pack: PublicPack) {
  return pack.listing.versions.map((v) => {
    const { reason, security, ...rest } = v;
    const text = { ...(reason !== undefined ? { reason } : {}), ...(security !== undefined ? { security } : {}) };
    return { ...rest, ...(Object.keys(text).length > 0 ? { publisher_text: text } : {}) };
  });
}

async function detail(runtime: McpRuntime, extras: PackExtras, pack: PublicPack, row: VersionRow) {
  const meta = await readMeta(runtime, pack.name, row.version);
  if (!meta) return undefined;
  const [excerpts, listed, flag, advisories, reported, adoptions, declaring] = await Promise.all([
    readExcerpts(runtime, pack.name, row.version),
    searchRow(runtime, pack.id),
    adoptVersionFlag(runtime),
    extras.advisories(pack),
    extras.reportedUnderReview(pack),
    extras.verifiedAdoptions(pack),
    extras.declaringRepositories(pack),
  ]);
  const card = (() => {
    try {
      return typeof listed?.card === "string" ? StoredCard.parse(JSON.parse(listed.card)) : undefined;
    } catch {
      return undefined;
    }
  })();
  const skills = excerpts?.skills ?? meta.inventory.skills.names.map((name) => ({ name, description: null }));
  const inventory = Object.fromEntries(
    Object.entries(meta.inventory).map(([part, v]) => [part, { count: v.count, tokens: v.tokens, publisher_text: { names: v.names } }]),
  );

  return {
    id: pack.name,
    status: pack.listing.status,
    ...(reported === true ? { status_label: REPORTED_LABEL } : {}),
    version: row.version,
    published_at: row.published_at,
    min_engine_version: row.min_engine_version,
    category: typeof listed?.category === "string" ? listed.category : null,
    publisher_text: {
      pitch: typeof listed?.pitch === "string" ? listed.pitch : null,
      tags: typeof listed?.tags === "string" ? listed.tags.split(" ").filter(Boolean) : [],
      readme_excerpt: excerpts?.readme?.slice(0, EXCERPT_LIMIT) ?? null,
      rules_excerpt: excerpts?.rules?.slice(0, EXCERPT_LIMIT) ?? null,
    },
    skills: skills.map((s) => ({ publisher_text: s })),
    manifest: { capabilities: meta.capabilities },
    inventory,
    preinstall: { publisher_text: meta.preinstall },
    verification: { verified: row.verified, verified_domain: row.verified_domain, verified_github_org: row.verified_github_org, source_verified: row.source_verified },
    provenance: meta.provenance,
    validation: { verdict: card?.verdict ?? null, rules_version: meta.rules_version },
    repository: card?.repository ?? null,
    score: { total: row.score ?? meta.score.total, parts: meta.score.parts, cap: meta.score.cap },
    signals: {
      stars: Number(listed?.stars ?? 0),
      rating: listed?.rating === null || listed?.rating === undefined ? null : Number(listed.rating),
      fetches_30d: Number(listed?.fetches_30d ?? 0),
      verified_adoptions: adoptions,
      declaring_repositories: declaring,
      declaring_repositories_note: "approximate; counted weekly from public repositories",
    },
    versions: versionsOf(pack),
    advisories: advisories === null ? null : advisories.map(advisoryOf),
    ...adoptSnippets(pack.name, flag, row.min_engine_version),
  };
}

export function registerPack(server: McpServer, runtime: McpRuntime, extras: PackExtras): void {
  server.registerTool(
    "get_pack",
    {
      description: describe(
        "Get the public view of one pack by exact name (for example '@acme/gcp'): manifest, inventory, pre-install manifest, README and RULES.md excerpts, skills, versions with published_at and status, provenance, validation verdict, verification facts, score, signals, advisories and how to adopt it. Never the full contents.",
      ),
      inputSchema: z.object({
        name: z.string().min(1).describe("Exact pack name, e.g. '@acme/gcp'"),
        version: z.string().optional().describe("An exact version; the newest eligible one by default"),
      }),
    },
    async ({ name, version }) => {
      try {
        const found = await findPublicPack(runtime, name);
        if (found.kind === "missing") return failure("not_found", "No public pack has that name.");
        if (found.kind === "unavailable") return unavailable();
        const { pack } = found;
        if (pack.listing.status === "removed") return failure("removed", "That pack has been removed.");

        let target: string | null | undefined = pack.listing.latest_eligible;
        if (version !== undefined) {
          const lookup = lookupVersion(pack.rows, version);
          if (lookup.kind === "missing") return failure("not_found", "That pack has no such version.");
          if (lookup.kind === "removed") return failure("removed", "That version has been removed.");
          if (lookup.kind === "held") {
            const { reason } = summarise(lookup.row, pack.notes.get(version));
            return answer({ id: pack.name, version, status: "quarantined", under_review: true, ...(reason !== undefined ? { publisher_text: { reason } } : {}) });
          }
          target = version;
        }
        const row = target ? pack.rows.find((r) => r.version === target) : undefined;
        if (!row) return answer({ id: pack.name, status: pack.listing.status, latest_eligible: null, versions: versionsOf(pack) });
        const view = await detail(runtime, extras, pack, row);
        if (!view) return unavailable();
        return answer({ ...view, latest_eligible: pack.listing.latest_eligible });
      } catch (error) {
        console.error(`get_pack failed: ${error instanceof Error ? error.message : String(error)}`);
        return unavailable();
      }
    },
  );
}

