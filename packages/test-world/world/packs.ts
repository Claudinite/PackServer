import { objectKey, publicObjectHttpMetadata, type ObjectKind } from "@packserver/core/catalog";
import { buildVersionsDocument, createSigner, sha256Hex, signVersionsDocument, utf8, type Signer, type VersionRecord } from "@packserver/core/index";
import { INVENTORY_PARTS, type Attestation, type Capability, type Meta, type PreInstallManifest, type VerificationFacts, type VersionStatus } from "@packserver/schema";
import type { ApiResponse, Driver, SeedStorage } from "../drivers/driver";
import type { Aliases } from "./alias";
import { InfrastructureError, NotImplemented } from "./errors";
import { Held, NotFound, Refusal, type Observation } from "./outcomes";
import { viewOfPackPage, type PackPageView } from "./page-view";
import type { Pack, Verification, Version } from "./types";

export interface PublicPackOptions {
  versions?: string[];
  /** A private pack is seeded so that tests can prove nothing about it leaks. */
  visibility?: "public" | "private";
  verification?: { verified?: boolean; verifiedDomain?: string; verifiedGithubOrg?: string; sourceVerified?: boolean };
  capabilities?: Capability[];
  preinstall?: Partial<PreInstallManifest>;
  /** The score `meta.json` and the version row carry; the default is 80 with no parts. */
  score?: Pick<Meta["score"], "total" | "parts">;
  /** How many of each inventory part `meta.json` counts; the default is none. */
  inventory?: Partial<Record<(typeof INVENTORY_PARTS)[number], number>>;
}

export interface StateChange {
  status: VersionStatus;
  reason?: string;
  security?: string;
}

/** What an exact or latest read answers once the HTTP shape is hidden. */
export interface PackBody {
  name: string;
  status: "active" | "removed";
  latest_eligible: string | null;
  versions: Array<{ version: string; status: VersionStatus; reason?: string; sha256?: string; yanked?: true; under_review?: true }>;
  version: VersionBody | null;
}
export interface VersionBody {
  version: string;
  status: VersionStatus;
  reason?: string;
  sha256?: string;
  yanked?: true;
  urls?: { archive: string; sha256: string; attestation: string; meta: string };
  verification: VerificationFacts;
  hashes: { canonical_sha256: string; upload_sha256: string | null };
  preinstall: PreInstallManifest;
  capabilities: Capability[];
  provenance: { source: string; source_verified: boolean; repository?: string; commit?: string };
  rules_version: string;
  validated_at: string;
  score: { total: number };
  report_published: boolean;
  [field: string]: unknown;
}
export type Read = (PackBody | { name: string; status: "removed"; version: unknown }) & { outcome: "found" | "removed" };

export interface ReadOptions {
  version?: string;
  /** Sends a session cookie: the response may then never be shared. */
  session?: boolean;
}

export interface VersionHandle extends Version {
  detail(): Promise<VersionBody>;
  canonicalSha256(): Promise<string>;
  uploadSha256(): Promise<string>;
  manifest(): Promise<PreInstallManifest>;
  capabilities(): Promise<Capability[]>;
  /** The response as the World exposes it, for comparing two resources. */
  observe(o?: Pick<ReadOptions, "session">): Promise<Observation>;
  /** Moves the seeded state of this version; the verbs that do it for real arrive with the lifecycle area. */
  seed(change: StateChange): Promise<void>;
}

export interface PackHandle extends Pack {
  version(version: string): VersionHandle;
  /** The public view: a body, `NotFound`, `Held` for a quarantined exact version, or a refusal. */
  read(o?: ReadOptions): Promise<Read | NotFound | Held | Refusal>;
  observe(o?: ReadOptions): Promise<Observation>;
  /**
   * The pack's page as an anonymous visitor (or, with `session`, a signed-in one) reads it. The page needs the pack's
   * search listing, so seed one with `search.list` first.
   */
  page(tab?: "overview" | "contents" | "versions", o?: ReadOptions): Promise<PackPageView | NotFound>;
  /** The README and files the validator will publish beside `meta.json` for the Contents tab. */
  seedContents(version: string, contents: { readme?: string | null; files?: Array<{ path: string; text: string }> }): Promise<void>;
  /** The published report of a version, with one warning finding per rule id given. */
  seedReport(version: string, report: { runId: string; warnings?: string[] }): Promise<void>;
  /** Gives the pack's scope a proof: every version's verification facts change, no object does. */
  seedProof(facts: { verified: boolean; verifiedDomain?: string; verifiedGithubOrg?: string }): Promise<void>;
  /** Moves every seeded version to `removed`, as a deleted pack looks to the registry. */
  seedRemoved(): Promise<void>;
  /** The bytes and ids the seed wrote, for assertions that look at stored objects. */
  stored(version: string): Promise<{ canonicalSha256: string; uploadSha256: string; keys: Record<ObjectKind, string>; objects: Array<{ kind: ObjectKind; key: string; size: number; contentType?: string; contentDisposition?: string; cacheControl?: string }> }>;
}

export interface HashAnswer {
  result: "canonical" | "upload" | "unknown";
  pack?: string;
  version?: string;
  status?: VersionStatus;
}

export interface PacksModule {
  public(name: string, opts?: PublicPackOptions): Promise<PackHandle>;
  private(name: string): Promise<Pack>;
  nonexistent(name: string): PackHandle;
  get(name: string): PackHandle;
  /** Verify by hash, anonymously, from the given source address. */
  verify(hash: string, o?: { ip?: string }): Promise<HashAnswer | Refusal>;
}

interface SeededVersion {
  version: string;
  id: string;
  status: VersionStatus;
  reason?: string;
  security?: string;
  statusChangedAt: string | null;
  publishedAt: string;
  canonicalSha256: string;
  uploadSha256: string;
  size: number;
}
interface SeededPack {
  name: string;
  systemName: string;
  scope: string;
  packName: string;
  visibility: "public" | "private";
  options: PublicPackOptions;
  versions: Map<string, SeededVersion>;
}

const SIGNER_SEED = new Uint8Array(32).fill(5);
const RULES_VERSION = "2026.10.1";
const MIN_ENGINE = "1.0.0";

const EMPTY_PREINSTALL: PreInstallManifest = { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] };

const bytesOf = (text: string): Uint8Array => utf8(text);

/** The pack read API and verify-by-hash, plus the seeding that stands in for publishing until it lands. */
export function createPacks(driver: Driver, aliases: Aliases): PacksModule {
  const seeded = new Map<string, SeededPack>();
  let storagePromise: Promise<SeedStorage> | undefined;
  let signer: Promise<Signer> | undefined;

  const storage = (): Promise<SeedStorage> => {
    if (!driver.storage || !driver.capabilities.has("storage")) {
      throw new InfrastructureError(`the ${driver.kind} driver cannot seed packs: it has no storage seam`);
    }
    return (storagePromise ??= driver.storage());
  };
  const sign = (): Promise<Signer> => (signer ??= createSigner({ kid: "2026-10", seed: SIGNER_SEED }));

  const nowMs = async (): Promise<number> => (driver.fakes ? driver.fakes.clock.call<number>("now") : Date.now());

  const get = (path: string, headers: Record<string, string> = {}): Promise<ApiResponse> =>
    driver.http.request({ surface: "web", method: "GET", path, headers });

  const parse = (res: ApiResponse): unknown => JSON.parse(aliases.unalias(res.text));

  const observation = (res: ApiResponse): Observation => ({
    status: res.status,
    headers: Object.fromEntries(["cache-control", "content-type"].flatMap((h) => (res.headers.has(h) ? [[h, res.headers.get(h) as string]] : []))),
    body: parse(res),
  });

  const splitName = (name: string): { scope: string; pack: string } => {
    const m = /^@([^/]+)\/(.+)$/.exec(name);
    if (!m) throw new InfrastructureError(`not a pack name: ${name}`);
    return { scope: m[1] as string, pack: m[2] as string };
  };

  function pathFor(system: string, version?: string): string {
    return `/api/packs/${system}${version ? `/${version}` : ""}`;
  }
  const headersFor = (o: ReadOptions | undefined): Record<string, string> => (o?.session ? { cookie: "session=scenario" } : {});

  async function read(system: string, o: ReadOptions = {}): Promise<Read | NotFound | Held | Refusal> {
    const res = await get(pathFor(system, o.version), headersFor(o));
    if (res.status === 404) return new NotFound();
    if (res.status === 429) return new Refusal("rate-limited");
    if (res.status === 451) return new Held((parse(res) as { reason?: string }).reason);
    if (res.status === 503) throw new InfrastructureError(`the read API was unavailable for ${system}: ${res.text}`);
    if (res.status !== 200 && res.status !== 410) throw new InfrastructureError(`the read API answered ${res.status} for ${system}: ${res.text}`);
    return { ...(parse(res) as object), outcome: res.status === 410 ? "removed" : "found" } as Read;
  }

  async function bodyOf(handle: PackHandle, o: ReadOptions): Promise<PackBody> {
    const out = await handle.read(o);
    if (out instanceof NotFound || out instanceof Held || out instanceof Refusal) throw new InfrastructureError(`${handle.name} ${o.version ?? ""} did not answer a view: ${out.constructor.name}`);
    return out as PackBody;
  }

  async function writeObjects(pack: SeededPack, v: SeededVersion): Promise<void> {
    const store = await storage();
    const verification = pack.options.verification ?? {};
    const sourceVerified = verification.sourceVerified ?? false;
    const facts: VerificationFacts = {
      verified: verification.verified ?? false,
      verified_domain: verification.verifiedDomain ?? null,
      verified_github_org: verification.verifiedGithubOrg ?? null,
      source_verified: sourceVerified,
    };
    const provenance: Meta["provenance"] = sourceVerified
      ? { source: "oidc", repository: `${pack.scope}/packs`, repository_id: 1234, commit: "b".repeat(40), ref: "refs/tags/v1", event: "push", workflow_run: "1", path: `packs/${pack.packName}`, source_verified: true }
      : { source: "upload", source_verified: false };
    const inventory = Object.fromEntries(INVENTORY_PARTS.map((p) => [p, { count: pack.options.inventory?.[p] ?? 0, names: [], tokens: null }])) as unknown as Meta["inventory"];
    const preinstall: PreInstallManifest = { ...EMPTY_PREINSTALL, ...pack.options.preinstall };
    const meta: Meta = {
      pack: pack.systemName,
      version: v.version,
      inventory,
      capabilities: pack.options.capabilities ?? [],
      preinstall,
      url_inventory: [],
      score: { total: pack.options.score?.total ?? 80, parts: pack.options.score?.parts ?? [], cap: null },
      rules_version: RULES_VERSION,
      verification: facts,
      provenance,
      diff_summary: { previous_version: null, files_added: 0, files_removed: 0, files_changed: 0, new_capabilities: [] },
    };
    const attestation: Attestation & { signature: string } = {
      pack: pack.systemName,
      version: v.version,
      upload_sha256: v.uploadSha256,
      canonical_sha256: v.canonicalSha256,
      provenance,
      rules_version: RULES_VERSION,
      validated_at: v.publishedAt,
      kid: "2026-10",
      signature: "c2ln",
    };
    const write = (kind: ObjectKind, body: Uint8Array | string) =>
      store.packsPublic.put(objectKey(pack.systemName, kind, v.version), body, { httpMetadata: publicObjectHttpMetadata(kind) });
    if (pack.visibility === "private") {
      await store.packsPrivate.put(`v/${v.id}/pack.tar.zst`, bytesOf(`archive ${pack.systemName}@${v.version}`));
      return;
    }
    await write("archive", bytesOf(`archive ${pack.systemName}@${v.version}`));
    await write("sha256", `${v.canonicalSha256}\n`);
    await write("attestation", JSON.stringify(attestation));
    await write("meta", JSON.stringify(meta));
  }

  async function writeHistory(pack: SeededPack): Promise<void> {
    if (pack.visibility === "private") return;
    const store = await storage();
    const facts = pack.options.verification ?? {};
    const records: VersionRecord[] = [...pack.versions.values()].map((v) => ({
      version: v.version,
      sha256: v.canonicalSha256,
      size: v.size,
      published_at: v.publishedAt,
      status: v.status,
      ...(v.status !== "active" ? { reason: v.reason ?? v.status } : {}),
      ...(v.security !== undefined ? { security: v.security } : {}),
      min_engine_version: MIN_ENGINE,
      requires: [],
      source_commit: null,
      preinstall: { ...EMPTY_PREINSTALL, ...pack.options.preinstall },
      verified: facts.verified ?? false,
      verified_domain: facts.verifiedDomain ?? null,
      verified_github_org: facts.verifiedGithubOrg ?? null,
      source_verified: facts.sourceVerified ?? false,
      status_changed_at: v.statusChangedAt,
    }));
    const now = new Date(await nowMs());
    const signed = await signVersionsDocument(buildVersionsDocument({ serial: 1, now, pack: { name: pack.systemName, versions: records } }), await sign());
    await store.packsPublic.put(objectKey(pack.systemName, "versions"), signed.bytes, { httpMetadata: publicObjectHttpMetadata("versions") });
  }

  async function writeRow(pack: SeededPack, v: SeededVersion): Promise<void> {
    const { db } = await storage();
    const facts = pack.options.verification ?? {};
    await db.batch([
      db
        .prepare(
          "INSERT OR REPLACE INTO pack_versions (id, pack_id, version, state, sha256, upload_sha256, size_bytes, published_at, verified, verified_domain, verified_github_org, source_verified, min_engine_version, requires, source_commit, score, score_rules_version, report_key) VALUES (?, (SELECT p.id FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(v.id, pack.scope, pack.packName, v.version, v.status, v.canonicalSha256, v.uploadSha256, v.size, v.publishedAt, facts.verified ? 1 : 0, facts.verifiedDomain ?? null, facts.verifiedGithubOrg ?? null, facts.sourceVerified ? 1 : 0, MIN_ENGINE, "[]", null, pack.options.score?.total ?? 80, RULES_VERSION, `reports/${v.id}.json`),
    ]);
  }

  async function seedVersion(pack: SeededPack, version: string): Promise<void> {
    const publishedAt = new Date(await nowMs()).toISOString();
    const canonicalBytes = bytesOf(`archive ${pack.systemName}@${version}`);
    const v: SeededVersion = {
      version,
      id: crypto.randomUUID(),
      status: "active",
      statusChangedAt: null,
      publishedAt,
      canonicalSha256: await sha256Hex(canonicalBytes),
      uploadSha256: await sha256Hex(bytesOf(`upload ${pack.systemName}@${version}`)),
      size: canonicalBytes.length,
    };
    pack.versions.set(version, v);
    await writeRow(pack, v);
    await writeObjects(pack, v);
  }

  async function seedPack(name: string, options: PublicPackOptions): Promise<PackHandle> {
    const { scope, pack: packName } = splitName(name);
    const visibility = options.visibility ?? "public";
    const systemScope = aliases.alias(scope);
    const pack: SeededPack = { name, systemName: `@${systemScope}/${packName}`, scope: systemScope, packName, visibility, options, versions: new Map() };
    const { db } = await storage();
    const created = new Date(await nowMs()).toISOString();
    const facts = options.verification ?? {};
    await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO scopes (id, name, kind, state, verified_domain, verified_github_org, created_at) VALUES (?, ?, 'org', 'active', ?, ?, ?)")
        .bind(crypto.randomUUID(), systemScope, facts.verifiedDomain ?? null, facts.verifiedGithubOrg ?? null, created),
      db
        .prepare("INSERT INTO packs (id, scope_id, name, visibility, created_at) VALUES (?, (SELECT id FROM scopes WHERE name = ?), ?, ?, ?)")
        .bind(crypto.randomUUID(), systemScope, packName, visibility, created),
    ]);
    seeded.set(name, pack);
    for (const version of options.versions ?? ["1.0.0"]) await seedVersion(pack, version);
    await writeHistory(pack);
    return handle(pack);
  }

  async function changeState(pack: SeededPack, version: string, change: StateChange): Promise<void> {
    const v = pack.versions.get(version);
    if (!v) throw new InfrastructureError(`${pack.name}@${version} was not seeded`);
    v.status = change.status;
    delete v.reason;
    delete v.security;
    if (change.reason !== undefined) v.reason = change.reason;
    if (change.security !== undefined) v.security = change.security;
    v.statusChangedAt = change.status === "active" ? null : new Date(await nowMs()).toISOString();
    const { db } = await storage();
    await db.batch([db.prepare("UPDATE pack_versions SET state = ? WHERE id = ?").bind(change.status, v.id)]);
    await writeHistory(pack);
  }

  function versionHandle(pack: SeededPack, owner: PackHandle, version: string): VersionHandle {
    const exact = (o?: Pick<ReadOptions, "session">) => get(pathFor(pack.systemName, version), headersFor(o));
    const body = async (): Promise<VersionBody> => {
      const res = await exact();
      if (res.status !== 200) throw new InfrastructureError(`${pack.name}@${version} did not answer a view (${res.status})`);
      const found = (parse(res) as PackBody).version;
      if (!found) throw new InfrastructureError(`${pack.name}@${version} answered no version`);
      return found;
    };
    return {
      pack: owner,
      version,
      async status() {
        const res = await exact();
        if (res.status === 451) return "quarantined";
        if (res.status === 410) return "removed";
        if (res.status === 404) throw new InfrastructureError(`${pack.name}@${version} does not exist`);
        return (await body()).status;
      },
      async sha256() {
        const hash = (await body()).sha256;
        if (!hash) throw new InfrastructureError(`${pack.name}@${version} publishes no hash`);
        return hash;
      },
      async verification(): Promise<Verification> {
        const f = (await body()).verification;
        return {
          verified: f.verified,
          ...(f.verified_domain ? { verifiedDomain: f.verified_domain } : {}),
          ...(f.verified_github_org ? { verifiedGithubOrg: f.verified_github_org } : {}),
        };
      },
      detail: body,
      async canonicalSha256() {
        return (await body()).hashes.canonical_sha256;
      },
      async uploadSha256() {
        const hash = (await body()).hashes.upload_sha256;
        if (!hash) throw new InfrastructureError(`${pack.name}@${version} has no upload hash`);
        return hash;
      },
      async manifest() {
        return (await body()).preinstall;
      },
      async capabilities() {
        return (await body()).capabilities;
      },
      async observe(o) {
        return observation(await exact(o));
      },
      seed: (change) => changeState(pack, version, change),
      approve: notYet("version.approve"),
      deprecate: notYet("version.deprecate"),
      yank: notYet("version.yank"),
      unyank: notYet("version.unyank"),
      delete: notYet("version.delete"),
    };
  }

  function handle(pack: SeededPack): PackHandle {
    const self: PackHandle = {
      name: pack.name,
      systemName: pack.systemName,
      version: (version) => versionHandle(pack, self, version),
      async versions() {
        const view = await bodyOf(self, {});
        return view.versions.map((v) => self.version(v.version));
      },
      async latest() {
        const view = await bodyOf(self, {});
        if (view.latest_eligible === null) throw new InfrastructureError(`${pack.name} has no eligible version`);
        return self.version(view.latest_eligible);
      },
      as: () => self,
      setVisibility: notYet("pack.setVisibility"),
      read: (o) => read(pack.systemName, o),
      async observe(o) {
        return observation(await get(pathFor(pack.systemName, o?.version), headersFor(o)));
      },
      async page(tab = "overview", o) {
        const path = `/packs/${pack.systemName}${tab === "overview" ? "" : `/${tab}`}${o?.version ? `?version=${o.version}` : ""}`;
        const res = await get(path, headersFor(o));
        if (res.status === 404) return new NotFound();
        return viewOfPackPage(res.status, aliases.unalias(res.text), { "cache-control": res.headers.get("cache-control") ?? "" });
      },
      async seedContents(version, contents) {
        if (!pack.versions.has(version)) throw new InfrastructureError(`${pack.name}@${version} was not seeded`);
        const { packsPublic } = await storage();
        await packsPublic.put(`${pack.systemName}/${version}/contents.json`, JSON.stringify({ readme: contents.readme ?? null, files: contents.files ?? [] }));
      },
      async seedReport(version, report) {
        const v = pack.versions.get(version);
        if (!v) throw new InfrastructureError(`${pack.name}@${version} was not seeded`);
        const { packsPublic } = await storage();
        const findings = (report.warnings ?? []).map((rule) => ({ rule, class: "warn", file: null, line: null, quote: null, hint: "see the rule" }));
        const body = {
          run_id: report.runId, pack: pack.systemName, version, rules_version: RULES_VERSION, started_at: v.publishedAt, finished_at: v.publishedAt,
          verdict: findings.length > 0 ? "warn" : "pass", steps: [], findings, tree_hash: null, canonical_sha256: v.canonicalSha256, source_verified: false, prose_screen: null, score: 80,
        };
        await packsPublic.put(`reports/${v.id}.json`, JSON.stringify(body));
      },
      async seedProof(facts) {
        pack.options = { ...pack.options, verification: { ...pack.options.verification, ...facts } };
        const { db } = await storage();
        await db.batch([
          db.prepare("UPDATE scopes SET verified_domain = ?, verified_github_org = ? WHERE name = ?").bind(facts.verifiedDomain ?? null, facts.verifiedGithubOrg ?? null, pack.scope),
          db
            .prepare("UPDATE pack_versions SET verified = ?, verified_domain = ?, verified_github_org = ? WHERE pack_id = (SELECT p.id FROM packs p JOIN scopes s ON s.id = p.scope_id WHERE s.name = ? AND p.name = ?)")
            .bind(facts.verified ? 1 : 0, facts.verifiedDomain ?? null, facts.verifiedGithubOrg ?? null, pack.scope, pack.packName),
        ]);
        await writeHistory(pack);
      },
      async seedRemoved() {
        for (const v of pack.versions.values()) {
          v.status = "removed";
          v.statusChangedAt = new Date(await nowMs()).toISOString();
        }
        const { db } = await storage();
        await db.batch([...pack.versions.values()].map((v) => db.prepare("UPDATE pack_versions SET state = 'removed' WHERE id = ?").bind(v.id)));
        await writeHistory(pack);
      },
      async stored(version) {
        const v = pack.versions.get(version);
        if (!v) throw new InfrastructureError(`${pack.name}@${version} was not seeded`);
        const store = await storage();
        const kinds: ObjectKind[] = ["archive", "sha256", "attestation", "meta"];
        const keys = Object.fromEntries([...kinds, "versions" as const].map((k) => [k, objectKey(pack.systemName, k, version)])) as Record<ObjectKind, string>;
        const objects = [];
        for (const kind of kinds) {
          const head = await store.packsPublic.head(keys[kind]);
          if (head) objects.push({ kind, key: keys[kind], size: head.size, ...head.httpMetadata });
        }
        return { canonicalSha256: v.canonicalSha256, uploadSha256: v.uploadSha256, keys, objects };
      },
    };
    return self;
  }

  return {
    public: (name, opts = {}) => seedPack(name, opts),
    private: notYet("packs.private") as PacksModule["private"],
    nonexistent(name) {
      const { scope, pack } = splitName(name);
      return handle({ name, systemName: `@${aliases.alias(scope)}/${pack}`, scope: aliases.alias(scope), packName: pack, visibility: "public", options: {}, versions: new Map() });
    },
    get(name) {
      const pack = seeded.get(name);
      if (!pack) throw new InfrastructureError(`${name} was not created in this scenario`);
      return handle(pack);
    },
    async verify(hash, o = {}) {
      const res = await get(`/api/verify/${hash}`, o.ip ? { "cf-connecting-ip": o.ip } : {});
      if (res.status === 429) return new Refusal("rate-limited");
      if (res.status !== 200) throw new InfrastructureError(`verify answered ${res.status}: ${res.text}`);
      return parse(res) as HashAnswer;
    },
  };
}

function notYet(verb: string): () => never {
  return () => {
    throw new NotImplemented(verb);
  };
}
