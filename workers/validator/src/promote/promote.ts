import { privateArchiveKey } from "@packserver/core/access";
import { extractArchive, type Tree } from "@packserver/core/canonical";
import { objectKey, publicObjectHttpMetadata, type ObjectKind } from "@packserver/core/catalog";
import { compareVersions, sha256Hex, signAttestation, utf8 } from "@packserver/core/index";
import { applyIndex, isCategory, SEARCH_PARTS, type Listing } from "@packserver/core/search";
import { indexOf, scorePack, treeOfScoreInputs } from "@packserver/core/score";
import { SYNTHETIC_KIND } from "@packserver/core/synthetic";
import { verificationFacts } from "@packserver/core/scopes";
import {
  attestationOf, buildContents, buildMeta, CONTENTS_HEADERS, contentsKey, diffSummary, inventoryOf, SandboxAReport, warningCounts,
} from "@packserver/core/validation";
import type { R2 } from "@packserver/ports";
import { loadRules } from "@packserver/rules";
import { Meta, type Capability, type PreInstallManifest, type ValidationReport } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import { loadSigning } from "../sign/keys";
import { getJson, runKeys } from "../workflow/report";
import { claimsOf, InfrastructureError, nowIso, provenanceOf, reports, stat } from "../workflow/steps";
import { NOTIFY_SCHEMA, type VersionPromoted } from "../notify/message";
import { loadPromotion, packOf, promotable, stagingReason, versionRow, type PromotionRun } from "./load";

export interface Context {
  rt: ValidatorRuntime;
  runId: string;
}

const EMPTY_CAPS = { capabilities: [] as Capability[], preinstall: { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] } as PreInstallManifest, widening: false };

const publicBucket = (rt: ValidatorRuntime): R2 => {
  const bucket = rt.ports.r2.PACKS_PUBLIC;
  if (!bucket) throw new Error("the PACKS_PUBLIC binding is missing");
  return bucket;
};
const privateBucket = (rt: ValidatorRuntime): R2 => {
  const bucket = rt.ports.r2.PACKS_PRIVATE;
  if (!bucket) throw new Error("the PACKS_PRIVATE binding is missing");
  return bucket;
};

const optionsOf = (h: { contentType: string; contentDisposition: string; cacheControl: string }) => ({
  content_type: h.contentType,
  content_disposition: h.contentDisposition,
  cache_control: h.cacheControl,
});

interface Material {
  run: PromotionRun;
  report: ValidationReport;
  a: SandboxAReport;
  canonical: Uint8Array;
  tree: Tree;
  capabilities: { capabilities: Capability[]; preinstall: PreInstallManifest; widening: boolean };
}

async function materialOf(rt: ValidatorRuntime, run: PromotionRun): Promise<Material> {
  const bucket = reports(rt);
  const canonical = await bucket.get(run.canonical_key!);
  if (!canonical) throw new InfrastructureError("promote.canonical_missing");
  if ((await sha256Hex(canonical)) !== run.canonical_sha256) throw new InfrastructureError("promote.canonical_mismatch");
  const tree = await extractArchive(canonical, { canonical: true });
  const a = SandboxAReport.parse(await getJson(bucket, runKeys.sandboxA(run.id)));
  const report = await getJson<ValidationReport>(bucket, run.report_key!);
  const capabilities = (a.capabilities ?? EMPTY_CAPS) as Material["capabilities"];
  return { run, report, a, canonical, tree, capabilities };
}

/**
 * The version row promotion commits: written `approved` here, before anything is put in a bucket,
 * because a private archive's key is the row's opaque id. A version some other run already holds
 * is not this run's to promote. A version REQ-VAL-038 or REQ-PUB-019 stages gets no row here and
 * is left for the owner's approval.
 */
export async function prepare(ctx: Context): Promise<{ promote: false } | { promote: true; versionId: string }> {
  const { rt, runId } = ctx;
  const d1 = rt.ports.d1;
  const run = await loadPromotion(d1, runId);
  if (!promotable(run)) return { promote: false };

  const existing = await versionRow(d1, run);
  if (existing) return existing.sha256 === run.canonical_sha256 ? { promote: true, versionId: existing.id } : { promote: false };

  const a = SandboxAReport.parse(await getJson(reports(rt), runKeys.sandboxA(runId)));
  const caps = (a.capabilities ?? EMPTY_CAPS) as Material["capabilities"];
  const facts = await verificationFacts(d1, run.scope_id);
  if (!facts) throw new InfrastructureError("promote.scope_missing");
  const at = await nowIso(rt);
  if (await stagingReason(d1, run, facts.verified, at)) return { promote: false };
  const claimed = await claimsOf(rt, run);
  const manifest = (a.manifest ?? {}) as { minEngineVersion?: unknown; requires?: unknown };
  const requires = Array.isArray(manifest.requires) ? manifest.requires.filter((r): r is string => typeof r === "string") : [];
  const versionId = rt.ports.rng.uuid();

  await d1.batch([
    {
      sql: `insert into packs (id, scope_id, name, visibility, created_at) values (?, ?, ?, 'public', ?) on conflict (scope_id, name) do nothing`,
      params: [rt.ports.rng.uuid(), run.scope_id, run.pack_name, at],
    },
    {
      sql: `insert into pack_versions (id, pack_id, version, state, sha256, upload_sha256, size_bytes, verified, verified_domain, verified_github_org, source_verified,
                                      min_engine_version, requires, source_commit, score, score_rules_version, report_key, preinstall)
            select ?, p.id, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? from packs p where p.scope_id = ? and p.name = ?
            on conflict (pack_id, version) do nothing`,
      params: [
        versionId, run.version, run.canonical_sha256, run.declared_sha256, a.canonical_bytes ?? 0,
        facts.verified ? 1 : 0, facts.verified_domain, facts.verified_github_org, run.source_verified === 1 ? 1 : 0,
        typeof manifest.minEngineVersion === "string" ? manifest.minEngineVersion : null, JSON.stringify(requires),
        claimed ? claimed.claims.sha : null, run.score, run.rules_version, run.report_key, JSON.stringify(caps.preinstall),
        run.scope_id, run.pack_name,
      ],
    },
  ]);
  const row = await versionRow(d1, run);
  if (!row) throw new InfrastructureError("promote.row_missing");
  if (row.sha256 !== run.canonical_sha256) return { promote: false };
  return { promote: true, versionId: row.id };
}

interface Previous {
  version: string;
  tree: Tree;
  capabilities: Capability[];
}

/** The newest version already published whose bytes and facts are still in the bucket. */
async function previousOf(rt: ValidatorRuntime, run: PromotionRun, visibility: "public" | "private"): Promise<Previous | null> {
  const pack = packOf(run);
  const rows = (
    await rt.ports.d1.query(
      `select v.id, v.version from pack_versions v join packs p on p.id = v.pack_id
        where p.scope_id = ? and p.name = ? and v.published_at is not null and v.version != ?`,
      [run.scope_id, run.pack_name, run.version],
    )
  ).rows.map((r) => ({ id: String(r.id), version: String(r.version) }));
  rows.sort((a, b) => compareVersions(b.version, a.version));
  const bucket = visibility === "private" ? privateBucket(rt) : publicBucket(rt);
  for (const candidate of rows) {
    const archive = await bucket.get(visibility === "private" ? privateArchiveKey(candidate.id) : objectKey(pack, "archive", candidate.version));
    const metaBytes = await bucket.get(objectKey(pack, "meta", candidate.version));
    if (!archive || !metaBytes) continue;
    const meta = Meta.pick({ capabilities: true }).safeParse(JSON.parse(new TextDecoder().decode(metaBytes)));
    if (!meta.success) continue;
    return { version: candidate.version, tree: await extractArchive(archive, { canonical: true }), capabilities: meta.data.capabilities };
  }
  return null;
}

/** 15a: the immutable objects, each put only if nothing is there, so a retry finds them and changes nothing. */
export async function writeObjects(ctx: Context, versionId: string): Promise<{ written: string[] }> {
  const { rt, runId } = ctx;
  const run = await loadPromotion(rt.ports.d1, runId);
  const row = await versionRow(rt.ports.d1, run);
  if (!row || row.id !== versionId) throw new InfrastructureError("promote.row_missing");
  const m = await materialOf(rt, run);
  const pack = packOf(run);
  const rules = loadRules(m.report.rules_version);
  const categories = new Map(rules.staticRules.rules.map((r) => [r.id, r.category]));
  const signing = await loadSigning(rt);

  const sourceVerified = run.source_verified === 1;
  const provenance = provenanceOf(await claimsOf(rt, run), sourceVerified);
  if (!m.a.score_inputs) throw new InfrastructureError("promote.score_inputs_missing");
  const scored = scorePack({
    tree: treeOfScoreInputs(m.a.score_inputs),
    capabilities: m.capabilities.capabilities,
    provenance,
    linkedPublicRepository: provenance.source === "oidc",
    publishedAdvisory: false,
    rulesVersion: m.report.rules_version,
  });
  const facts = await verificationFacts(rt.ports.d1, run.scope_id);
  if (!facts) throw new InfrastructureError("promote.scope_missing");
  const previous = await previousOf(rt, run, row.visibility);

  const meta = buildMeta({
    pack,
    version: run.version,
    tree: m.tree,
    capabilities: m.capabilities.capabilities,
    preinstall: m.capabilities.preinstall,
    urls: m.a.urls as unknown as Array<{ url: string; file: string; line: number | null; classification: string }>,
    score: { total: scored.total, parts: scored.parts, cap: scored.cap },
    rulesVersion: m.report.rules_version,
    verification: { verified: facts.verified, verified_domain: facts.verified_domain, verified_github_org: facts.verified_github_org, source_verified: sourceVerified },
    provenance,
    diff: diffSummary({ previous, tree: m.tree, capabilities: m.capabilities.capabilities }),
    warnings: warningCounts(m.report.findings, (rule) => categories.get(rule)),
    validationRun: run.id,
  });
  const attestation = await signAttestation(
    attestationOf({
      pack,
      version: run.version,
      uploadSha256: run.declared_sha256,
      canonicalSha256: run.canonical_sha256!,
      provenance,
      rulesVersion: m.report.rules_version,
      validatedAt: run.finished_at!,
      kid: signing.signer.kid,
    }),
    signing.signer,
  );

  const written: string[] = [];
  const put = async (bucket: R2, key: string, body: Uint8Array, headers: Parameters<typeof optionsOf>[0]) => {
    if (await bucket.putIfAbsent(key, body, optionsOf(headers))) written.push(key);
  };
  const json = (value: unknown) => utf8(JSON.stringify(value));
  if (row.visibility === "private") {
    const bucket = privateBucket(rt);
    await put(bucket, privateArchiveKey(versionId), m.canonical, publicObjectHttpMetadata("archive"));
    await put(bucket, objectKey(pack, "attestation", run.version), json(attestation), publicObjectHttpMetadata("attestation"));
    await put(bucket, objectKey(pack, "meta", run.version), json(meta), publicObjectHttpMetadata("meta"));
    return { written };
  }
  const bucket = publicBucket(rt);
  const kinds: Array<[Exclude<ObjectKind, "versions">, Uint8Array]> = [
    ["archive", m.canonical],
    ["sha256", utf8(`${run.canonical_sha256}\n`)],
    ["attestation", json(attestation)],
    ["meta", json(meta)],
  ];
  for (const [kind, body] of kinds) await put(bucket, objectKey(pack, kind, run.version), body, publicObjectHttpMetadata(kind));
  await put(bucket, contentsKey(pack, run.version), json(buildContents(m.tree)), CONTENTS_HEADERS);
  return { written };
}

/** 15b: the one commit. The coordinator flips the row from `approved` to `active`; a version already past `approved` is promoted already. */
export async function commit(ctx: Context): Promise<{ promoted: boolean; alreadyPromoted: boolean }> {
  const { rt, runId } = ctx;
  const run = await loadPromotion(rt.ports.d1, runId);
  const answer = await rt.ports.durableObjects.call("ScopeCoordinator", run.scope, "insertVersion", [{ run_id: runId, pack: packOf(run), version: run.version }]);
  if (!answer.promoted && !answer.already_promoted) throw new InfrastructureError("promote.commit_refused");
  if (answer.promoted) stat(rt, "publish.promoted", [packOf(run), run.source]);
  return { promoted: answer.promoted, alreadyPromoted: answer.already_promoted };
}

/** 15c: the scope's indexes and private entries are rebuilt from the registry database by the coordinator, which has the validator sign them. */
export async function reindex(ctx: Context): Promise<{ sha256: string; serial: number }> {
  const { rt, runId } = ctx;
  const run = await loadPromotion(rt.ports.d1, runId);
  const built = await rt.ports.durableObjects.call("ScopeCoordinator", run.scope, "rebuildIndex", [{ scope: run.scope }]);
  return { sha256: built.sha256, serial: built.serial };
}

const SKILL_PATH = /^skills\/[^/]+\/SKILL\.md$/;

/** 15d: the full-text row and the vector, both keyed by pack, so a second pass rewrites what the first wrote. */
export async function search(ctx: Context): Promise<{ indexed: boolean }> {
  const { rt, runId } = ctx;
  const run = await loadPromotion(rt.ports.d1, runId);
  const row = await versionRow(rt.ports.d1, run);
  if (!row || row.visibility !== "public" || run.scope_kind === SYNTHETIC_KIND) return { indexed: false };
  const m = await materialOf(rt, run);
  const index = indexOf(m.tree);
  const manifest = (m.a.manifest ?? {}) as { pitch?: unknown; tags?: unknown; category?: unknown };
  const category = typeof manifest.category === "string" && isCategory(manifest.category) ? manifest.category : "other";
  const inventory = inventoryOf(m.tree, m.capabilities.preinstall, m.capabilities.capabilities);
  const rules = loadRules(m.report.rules_version);
  const perToken = rules.score.thresholds.chars_per_token;
  const always = (index.text("RULES.md")?.length ?? 0) + index.skills.reduce((n, s) => n + `${s.name ?? ""} ${s.description ?? ""}`.length, 0);
  const published = (await rt.ports.d1.query(`select published_at from pack_versions where id = ?`, [row.id])).rows[0];
  const provenance = provenanceOf(await claimsOf(rt, run), run.source_verified === 1);
  const facts = await verificationFacts(rt.ports.d1, run.scope_id);
  const at = await nowIso(rt);

  const listing: Listing = {
    packId: row.pack_id,
    name: packOf(run),
    scopeKind: run.scope_kind,
    pitch: typeof manifest.pitch === "string" ? manifest.pitch : "",
    category,
    tags: Array.isArray(manifest.tags) ? manifest.tags.filter((t): t is string => typeof t === "string") : [],
    skills: index.skills.filter((s) => SKILL_PATH.test(s.path)).map((s) => ({ name: s.name ?? s.dir.slice("skills/".length), description: s.description ?? "" })),
    stored: {
      inventory_counts: Object.fromEntries(SEARCH_PARTS.map((p) => [p, inventory[p].count])),
      context_cost: Math.ceil(always / perToken),
      verdict: run.verdict === "warn" ? "warn" : "pass",
      repository: provenance.source === "oidc" ? provenance.repository : null,
      score_parts: [],
    },
    hasRepository: provenance.source === "oidc",
    promotedAt: published?.published_at ? String(published.published_at) : at,
    newest: { version: run.version, publishedAt: published?.published_at ? String(published.published_at) : at, minEngineVersion: typeof (m.a.manifest ?? {}).minEngineVersion === "string" ? String(m.a.manifest!.minEngineVersion) : null },
    verification: { verified: facts?.verified ?? false, domain: facts?.verified_domain ?? null, githubOrg: facts?.verified_github_org ?? null },
    score: run.score ?? 0,
    stars: 0,
    rating: null,
  };
  const applied = await applyIndex({ d1: rt.ports.d1, embedder: rt.ports.embedder, vectors: rt.ports.vectors }, listing, at);
  return { indexed: applied !== null };
}

/** 15e: one message per promoted version, deduplicated by the consumer on `(version_id, "promoted")`. */
export async function notify(ctx: Context, versionId: string): Promise<void> {
  const { rt, runId } = ctx;
  const run = await loadPromotion(rt.ports.d1, runId);
  const queue = rt.ports.queues.NOTIFY_QUEUE;
  if (!queue) throw new Error("the NOTIFY_QUEUE binding is missing");
  const message: VersionPromoted = {
    schema: NOTIFY_SCHEMA,
    type: "version.promoted",
    version_id: versionId,
    pack: packOf(run),
    version: run.version,
    run_id: runId,
    dedupe: `${versionId}:promoted`,
  };
  await queue.send(message);
}
