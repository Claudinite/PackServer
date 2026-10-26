import { buildPrivateEntry, buildScopeIndex, type PackRecord, type VersionRecord } from "@packserver/core/index";
import { contentDigest, DOC_KEY } from "@packserver/core/validation";
import { verificationFacts } from "@packserver/core/scopes";
import type { D1 } from "@packserver/ports";
import { PreInstallManifest, type IndexVersion, type VersionStatus } from "@packserver/schema";
import type { IndexRebuilder } from "./scope-coordinator";

/** The validator's signing entrypoints, which write what they sign. */
export interface IndexSigner {
  signScopeIndex(request: { scope: string; unsigned: ReturnType<typeof buildScopeIndex> }): Promise<{ sha256: string; serial: number }>;
  signPrivateEntries(request: { scope: string; entries: Array<ReturnType<typeof buildPrivateEntry>> }): Promise<unknown>;
}

/** A private entry nobody has changed is still re-signed this often so its `expires` never lapses. */
export const PRIVATE_RESIGN_MS = 24 * 3_600_000;

const EMPTY_PREINSTALL = { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] };

interface Row {
  pack_name: string;
  visibility: string;
  id: string;
  version: string;
  state: string;
  sha256: string;
  size_bytes: number;
  published_at: string;
  verified: number;
  verified_domain: string | null;
  verified_github_org: string | null;
  source_verified: number;
  min_engine_version: string | null;
  requires: string | null;
  source_commit: string | null;
  preinstall: string | null;
  status_reason: string | null;
  status_security: string | null;
  status_changed_at: string | null;
}

function listedOf(row: Row): IndexVersion {
  const status = row.state as VersionStatus;
  const reason = row.status_reason ?? (status === "active" ? undefined : status);
  const security = status === "revoked" ? (row.status_security ?? reason) : (row.status_security ?? undefined);
  return {
    version: row.version,
    sha256: row.sha256,
    size: Number(row.size_bytes),
    published_at: row.published_at,
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(security !== undefined ? { security } : {}),
    min_engine_version: row.min_engine_version ?? "0.0.0",
    requires: row.requires ? (JSON.parse(row.requires) as string[]) : [],
    source_commit: row.source_commit,
    preinstall: PreInstallManifest.parse(row.preinstall ? JSON.parse(row.preinstall) : EMPTY_PREINSTALL),
    verified: Boolean(row.verified),
    verified_domain: row.verified_domain,
    verified_github_org: row.verified_github_org,
    source_verified: Boolean(row.source_verified),
  };
}

function versionOf(row: Row): VersionRecord {
  return { ...listedOf(row), status_changed_at: row.state === "active" ? null : (row.status_changed_at ?? row.published_at) };
}

/**
 * Rebuilds one scope from the registry database alone (the coordinator has no bucket access):
 * the scope's verification facts are refreshed onto its versions, the public packs become the
 * scope index and the private packs their entries, and the validator signs and writes both.
 * A private entry is re-signed only when its content changed or the last signing is a day old.
 */
export function createIndexRebuilder(deps: { d1: D1; signer: IndexSigner; now: () => number }): IndexRebuilder {
  const { d1, signer } = deps;
  return {
    async rebuild(scopeName) {
      const scope = (await d1.query(`select id from scopes where name = ?`, [scopeName])).rows[0];
      if (!scope) throw new Error(`rebuild.unknown_scope: ${scopeName}`);
      const scopeId = String(scope.id);
      const now = new Date(deps.now());

      const facts = await verificationFacts(d1, scopeId);
      if (facts) {
        await d1.query(
          `update pack_versions set verified = ?, verified_domain = ?, verified_github_org = ?
            where pack_id in (select id from packs where scope_id = ?)
              and (verified != ? or verified_domain is not ? or verified_github_org is not ?)`,
          [facts.verified ? 1 : 0, facts.verified_domain, facts.verified_github_org, scopeId, facts.verified ? 1 : 0, facts.verified_domain, facts.verified_github_org],
        );
      }

      const rows = (
        await d1.query(
          `select p.name as pack_name, p.visibility, v.* from pack_versions v join packs p on p.id = v.pack_id
            where p.scope_id = ? and v.published_at is not null and v.state not in ('pending', 'approved')`,
          [scopeId],
        )
      ).rows as unknown as Row[];
      const byPack = new Map<string, { visibility: string; rows: Row[] }>();
      for (const row of rows) {
        const group = byPack.get(row.pack_name) ?? { visibility: row.visibility, rows: [] };
        group.rows.push(row);
        byPack.set(row.pack_name, group);
      }
      const publicPacks: PackRecord[] = [];
      const privateEntries: Array<{ pack: string; rows: Row[] }> = [];
      for (const [name, group] of byPack) {
        const pack = `@${scopeName}/${name}`;
        if (group.visibility === "public") publicPacks.push({ name: pack, versions: group.rows.map(versionOf) });
        else privateEntries.push({ pack, rows: group.rows });
      }

      const previous = async (docKey: string) => (await d1.query(`select serial, content_hash, signed_at from signed_documents where doc_key = ?`, [docKey])).rows[0];
      const last = await previous(DOC_KEY.scope(scopeName));
      const unsigned = buildScopeIndex({ scope: scopeName, serial: last ? Number(last.serial) + 1 : 1, now, packs: publicPacks });
      const written = await signer.signScopeIndex({ scope: scopeName, unsigned });

      const due: Array<ReturnType<typeof buildPrivateEntry>> = [];
      for (const entry of privateEntries) {
        const before = await previous(DOC_KEY.private(entry.pack));
        const doc = buildPrivateEntry({
          pack: entry.pack,
          serial: before ? Number(before.serial) + 1 : 1,
          now,
          versions: entry.rows.map((row) => ({ ...listedOf(row), version_id: row.id })),
        });
        const stale = !before || now.getTime() - Date.parse(String(before.signed_at)) >= PRIVATE_RESIGN_MS;
        if (stale || before.content_hash !== (await contentDigest(doc))) due.push(doc);
      }
      if (due.length > 0) await signer.signPrivateEntries({ scope: scopeName, entries: due });
      return written;
    },
  };
}
