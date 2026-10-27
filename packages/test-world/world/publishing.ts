import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { objectKey, type ObjectKind } from "@packserver/core/catalog";
import { verifyAttestation } from "@packserver/core/index";
import { contentsKey } from "@packserver/core/validation";
import { fixtureArchive, type FixtureName } from "@packserver/core/canonical/fixtures";
import type { ApiResponse, Driver, StorageAccess } from "../drivers/driver";
import type { Aliases } from "./alias";
import type { CiModule, Presigned, UploadCredential } from "./ci-workflow";
import { InfrastructureError, NotImplemented } from "./errors";
import type { Finding, ValidationReport } from "@packserver/schema";
import { Refusal, type RefusalReason } from "./outcomes";
import { callerOf } from "./areas/users";
import { seededRegistryKey } from "./packs";
import type { ScopeOwner, ScopesModule } from "./areas/scopes";
import type { Archive, Passkey, Pack, PublisherOpts, Sensitive, User, UserOpts, ValidationRun, Version, VersionStatus, Verification } from "./types";

export interface ArchiveOptions {
  version?: string;
  minEngineVersion?: string;
  files?: Record<string, string | null>;
  /** Appends skippable frames until the archive is exactly this long; still valid zstd. */
  padTo?: number;
  /** `gzip` wraps the archive in a different compression format. */
  format?: "gzip";
}

/** A fixture archive and the facts a publish declares about it. */
export interface ArchiveHandle extends Archive {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** Present when the archive was built without a `version`: the same archive carrying the version it is published as. */
  readonly asVersion?: (version: string) => ArchiveHandle;
}

export interface RunMilestone {
  step: string;
  outcome: "ok" | "fail" | "skipped";
  detail?: string;
  at: string;
}
/** Why a validated version waits for an owner, and whether one has approved it. */
export interface ApprovalState {
  state: "awaiting" | "approved";
  reasons: string[];
}
/** What an owner is shown before approving. */
export interface ApprovalSheet {
  state: "awaiting" | "approved";
  reasons: string[];
  sheet: {
    pack: string;
    version: string;
    widening: boolean;
    against: string | null;
    /** Pre-install entries the previous promoted version lacked, listed first. */
    new: string[];
    capabilities: { added: string[]; removed: string[] };
    files: Array<{ path: string; change: "added" | "removed" | "modified"; added_lines: number; removed_lines: number }>;
  };
}
export interface RunView {
  run_id: string;
  kind: "publish" | "dry-run";
  pack: string;
  version: string;
  status: "queued" | "running" | "finished";
  verdict: "pass" | "warn" | "hold" | "fail" | "error" | null;
  reason: string | null;
  queued: { reason: string; start_after: string; until: string } | null;
  approval: ApprovalState | null;
  milestones: RunMilestone[];
}

export interface Commit {
  treeHash: string | null;
  canonicalSha256: string | null;
  canonical: Uint8Array | null;
}

/** One validation run as its publisher sees it; every read asks the system again. */
export class Run implements ValidationRun {
  constructor(
    readonly id: string,
    private readonly fetchView: () => Promise<RunView>,
    private readonly readReport: () => Promise<ValidationReport | null> = async () => null,
    private readonly readCommit: () => Promise<Commit> = async () => ({ treeHash: null, canonicalSha256: null, canonical: null }),
  ) {}
  /** The report the validator wrote, or null while there is none (or never, when the run ended `error`). */
  report(): Promise<ValidationReport | null> {
    return this.readReport();
  }
  /** The form the validator committed at step 7, and the canonical archive that waits in the reports bucket. */
  commit(): Promise<Commit> {
    return this.readCommit();
  }
  /** The report's findings, failures first as written; throws when there is no report. */
  async findings(): Promise<Finding[]> {
    const report = await this.readReport();
    if (!report) throw new InfrastructureError(`the run ${this.id} has no report`);
    return report.findings;
  }
  /** Polls until the validator has finished the run; real time, because the Workflow runs in real time. */
  async finished(timeoutMs = 90_000): Promise<this> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { status } = await this.view();
      if (status === "finished") return this;
      if (Date.now() > deadline) throw new InfrastructureError(`the run ${this.id} was still ${status} after ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  view(): Promise<RunView> {
    return this.fetchView();
  }
  async verdict(): Promise<"pass" | "warn" | "hold" | "fail" | "rejected" | "error"> {
    const { verdict, status } = await this.view();
    if (verdict === null) throw new InfrastructureError(`the run ${this.id} has no verdict yet (it is ${status})`);
    return verdict;
  }
  async status(): Promise<RunView["status"]> {
    return (await this.view()).status;
  }
  /** Why the run ended as it did: a refusal code such as `integrity.sha256_mismatch`. */
  async reason(): Promise<string | null> {
    return (await this.view()).reason;
  }
  async milestones(): Promise<RunMilestone[]> {
    return (await this.view()).milestones;
  }
  async queued(): Promise<RunView["queued"]> {
    return (await this.view()).queued;
  }
}

/** A refusal the site gave, or a harness error when it said nothing a scenario could assert on. */
function refusalOfResponse(res: ApiResponse, what: string): Refusal {
  let body: { reason?: RefusalReason; message?: string } = {};
  try {
    body = res.json() as typeof body;
  } catch {
    /* reported below */
  }
  if (!body.reason) throw new InfrastructureError(`${what}: ${res.status} without a refusal: ${res.text.slice(0, 160)}`);
  return new Refusal(body.reason, body.message === undefined ? {} : { message: body.message });
}

export interface PublishedVersion {
  objects: Array<{ kind: ObjectKind; key: string; size: number; contentType?: string; contentDisposition?: string; cacheControl?: string }>;
  archive: Uint8Array;
  canonicalSha256: string;
  shaFile: string;
  attestation: { document: Record<string, unknown>; verifies: boolean; failure?: string };
  meta: Record<string, unknown>;
  contents: { readme: string | null; files: Array<{ path: string; text: string }> };
}

/** What a publish returns before promotion exists: the version as admitted, with the run that validates it. */
export class AdmittedVersion implements Version {
  constructor(
    readonly pack: Pack,
    readonly version: string,
    readonly run: Run,
    private readonly declaredSha256: () => Promise<string>,
    private readonly storage: () => StorageAccess,
    private readonly driver?: Driver,
  ) {}
  private sql(statement: string, params: unknown[] = []) {
    return this.storage().sql(statement, params);
  }
  private async row(): Promise<Record<string, unknown> | undefined> {
    return (
      await this.sql(
        `select v.id, v.state, v.verified, v.verified_domain, v.verified_github_org from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
          where s.name || '/' || p.name = ? and v.version = ?`,
        [this.pack.systemName.slice(1), this.version],
      )
    )[0];
  }
  /** The row id promotion gave the version, which keys a private archive. */
  async versionId(): Promise<string> {
    const row = await this.row();
    if (!row) throw new InfrastructureError(`${this.pack.systemName}@${this.version} has no version row: it was not promoted`);
    return String(row.id);
  }
  /**
   * What promotion put in the public bucket for the version, read back as a cn would: the four write-once
   * objects with their headers, the attestation checked against the registry's key, and the contents document.
   */
  async published(): Promise<PublishedVersion> {
    const { packs } = this.storage();
    const name = this.pack.systemName;
    const kinds: ObjectKind[] = ["archive", "sha256", "attestation", "meta"];
    const objects: PublishedVersion["objects"] = [];
    for (const kind of kinds) {
      const key = objectKey(name, kind, this.version);
      const head = await packs.public.head(key);
      if (head) objects.push({ kind, key, size: head.size, ...head.httpMetadata });
    }
    const bytes = async (kind: ObjectKind | "contents") => {
      const key = kind === "contents" ? contentsKey(name, this.version) : objectKey(name, kind, this.version);
      const body = await packs.public.get(key);
      if (!body) throw new InfrastructureError(`${key} was not written`);
      return body;
    };
    const json = async (kind: ObjectKind | "contents") => JSON.parse(new TextDecoder().decode(await bytes(kind))) as Record<string, unknown>;
    const archive = await bytes("archive");
    const canonicalSha256 = createHash("sha256").update(archive).digest("hex");
    const attestation = await json("attestation");
    const verdict = await verifyAttestation(attestation, {
      keys: [await seededRegistryKey()],
      expect: { pack: name, version: this.version, canonical_sha256: canonicalSha256 },
    });
    return {
      objects,
      archive,
      canonicalSha256,
      shaFile: new TextDecoder().decode(await bytes("sha256")).trim(),
      attestation: { document: attestation, verifies: verdict.ok, ...(verdict.ok ? {} : { failure: verdict.code }) },
      meta: await json("meta"),
      contents: (await json("contents")) as unknown as PublishedVersion["contents"],
    };
  }
  /** Polls until promotion has made the version active; real time, because the Workflow runs in real time. */
  async promoted(timeoutMs = 90_000): Promise<this> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.row())?.state === "active") return this;
      if (Date.now() > deadline) throw new InfrastructureError(`${this.pack.systemName}@${this.version} was not promoted within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  /** The hash the registry holds for this version: the one its admitted run declared. */
  sha256(): Promise<string> {
    return this.declaredSha256();
  }
  private missing(verb: string): never {
    throw new NotImplemented(`version.${verb}`);
  }
  async status(): Promise<VersionStatus> {
    const row = await this.row();
    if (!row) throw new InfrastructureError(`${this.pack.systemName}@${this.version} has no version row`);
    return String(row.state) as VersionStatus;
  }
  /**
   * An owner's approval of a version that waits for one, made through the site with a passkey assertion for this run.
   * `by` is the person approving; the assertion is made for them unless `assertion` says otherwise.
   */
  async approve(o: Sensitive & { by?: User; passkey?: Passkey } = {}): Promise<void> {
    if (!o.by) throw new InfrastructureError("version.approve: say who approves, with { by: user }");
    const caller = callerOf(o.by);
    const how: Sensitive = o.passkey ? { assertion: await o.by.assertionFor({ action: "publish.approve", target: this.run.id }, { passkey: o.passkey }) } : o;
    const headers = await caller.assertionHeaders("publish.approve", how, this.run.id);
    const res = await caller.call({ method: "POST", path: `/api/publish/runs/${this.run.id}/approve`, json: {}, headers });
    if (res.status >= 200 && res.status < 300) return;
    throw refusalOfResponse(res, "version.approve");
  }
  /** Dates this version's promotion `days` before `from`, the faked now: the scope's coordinator stamps promotions with the host's own clock. */
  async backdate(days: number, from: Date): Promise<void> {
    await this.sql("update pack_versions set published_at = ? where id = ?", [new Date(from.getTime() - days * 86_400_000).toISOString(), String((await this.row())?.id)]);
  }
  /** Whether the version's archive is in the public bucket, which is what a download is served from. */
  async downloadable(): Promise<boolean> {
    return (await this.storage().packs.public.head(objectKey(this.pack.systemName, "archive", this.version))) !== null;
  }
  /** Whether the version waits for an owner, and why; none when nothing stages it. */
  async approval(): Promise<ApprovalState | null> {
    return (await this.run.view()).approval;
  }
  /** The sheet an owner is shown, read as that owner. */
  async approvalSheet(by: User): Promise<ApprovalSheet> {
    const res = await callerOf(by).call({ method: "GET", path: `/api/publish/runs/${this.run.id}/approval` });
    if (res.status !== 200) throw refusalOfResponse(res, "version.approvalSheet");
    return res.json() as ApprovalSheet;
  }
  /** The publisher's one appeal against a rejection of this version. */
  async appeal(note: string, by: User): Promise<void> {
    const res = await callerOf(by).call({ method: "POST", path: `/api/publish/runs/${this.run.id}/appeal`, json: { note } });
    if (res.status >= 200 && res.status < 300) return;
    throw refusalOfResponse(res, "version.appeal");
  }
  private internal(method: "POST" | "DELETE", path: string, body?: unknown): Promise<ApiResponse> {
    if (!this.driver) throw new InfrastructureError("this version cannot reach the validator");
    return this.driver.http.request({ surface: "validator", method, path, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  /** Ends the run's workflow instance where it stands, as a Workflow class migration leaves a decision with no instance waiting. */
  async abandonInstance(): Promise<void> {
    const res = await this.internal("DELETE", `/internal/runs/${this.run.id}/instance`);
    if (res.status !== 200) throw new InfrastructureError(`version.abandonInstance: the validator answered ${res.status}: ${res.text.slice(0, 120)}`);
  }
  /** Runs the validator's resumer for this run, as its cron does for every run, and answers how each decision was applied. */
  async resume(): Promise<Array<{ source: string; delivered: "event" | "instance" | "nothing" }>> {
    const res = await this.internal("POST", "/internal/resume", { run_id: this.run.id });
    if (res.status !== 200) throw new InfrastructureError(`version.resume: the validator answered ${res.status}: ${res.text.slice(0, 120)}`);
    return (res.json() as { resumed: Array<{ source: string; delivered: "event" | "instance" | "nothing" }> }).resumed;
  }
  deprecate(): Promise<void> {
    return this.missing("deprecate");
  }
  yank(): Promise<void> {
    return this.missing("yank");
  }
  unyank(): Promise<void> {
    return this.missing("unyank");
  }
  delete(): Promise<void> {
    return this.missing("delete");
  }
  async verification(): Promise<Verification> {
    const row = await this.row();
    if (!row) throw new InfrastructureError(`${this.pack.systemName}@${this.version} has no version row`);
    return {
      verified: Boolean(row.verified),
      ...(row.verified_domain ? { verifiedDomain: String(row.verified_domain) } : {}),
      ...(row.verified_github_org ? { verifiedGithubOrg: String(row.verified_github_org) } : {}),
    };
  }
}

/** A person's options, plus whether their personal scope is a Verified Publisher's. */
export type PublisherHandleOpts = UserOpts & Pick<PublisherOpts, "verified">;

export interface PublishOptions {
  visibility?: "private";
  staged?: true;
  /** The sha256 the publisher declares; default is the archive's own. */
  declaredSha256?: string;
}

export interface PublisherHandle extends ScopeOwner {
  publish(archive: ArchiveHandle): { as(nameAtVersion: string, o?: PublishOptions): Promise<AdmittedVersion> };
  dryRun(archive: ArchiveHandle, o?: { proseScreen?: boolean }): Promise<Run>;
  /** The upload half of a publish, with the start left for later: what a credential issued earlier can still do. */
  upload(archive: ArchiveHandle, nameAtVersion: string): Promise<{ start(o?: PublishOptions): Promise<AdmittedVersion> }>;
}

const SKIPPABLE_OVERHEAD = 8;

function skippableFrames(length: number): Uint8Array {
  if (length < SKIPPABLE_OVERHEAD) throw new InfrastructureError(`cannot pad by ${length} bytes: a skippable frame is ${SKIPPABLE_OVERHEAD} bytes before its payload`);
  const out = new Uint8Array(length);
  out.set([0x50, 0x2a, 0x4d, 0x18]);
  new DataView(out.buffer).setUint32(4, length - SKIPPABLE_OVERHEAD, true);
  return out;
}

function makeArchive(fixture: string, opts: ArchiveOptions): ArchiveHandle {
  let bytes: Uint8Array = fixtureArchive(fixture as FixtureName, {
    ...(opts.version === undefined ? {} : { version: opts.version }),
    ...(opts.minEngineVersion === undefined ? {} : { minEngineVersion: opts.minEngineVersion }),
    ...(opts.files === undefined ? {} : { files: opts.files }),
  });
  if (opts.format === "gzip") bytes = gzipSync(bytes);
  if (opts.padTo !== undefined) {
    if (bytes.byteLength > opts.padTo) throw new InfrastructureError(`the ${fixture} archive is ${bytes.byteLength} bytes, more than the ${opts.padTo} it is to be padded to`);
    const padded = new Uint8Array(opts.padTo);
    padded.set(bytes);
    if (opts.padTo > bytes.byteLength) padded.set(skippableFrames(opts.padTo - bytes.byteLength), bytes.byteLength);
    bytes = padded;
  }
  const handle: ArchiveHandle = { fixture, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  return opts.version === undefined ? { ...handle, asVersion: (version) => makeArchive(fixture, { ...opts, version }) } : handle;
}

const NAME_AT_VERSION = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const KNOWN_REASONS = new Set<string>(["quota", "exists", "forbidden", "oidc.invalid", "signature", "rate-limited", "scope", "category", "trusted-only"]);

/** Publishing as a signed-in person: the archive, the publisher, the wizard's publish and dry-run, and a version's run. */
export function createPublishFlow(driver: Driver, aliases: Aliases, scopes: Pick<ScopesModule, "publishers">, ci: CiModule, ensureEngines: () => Promise<void>) {
  const storage = () => {
    if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver has no storage access: publishers cannot be seeded on a deployment`);
    return driver.publishStorage;
  };

  async function send(path: string, init: { method: "GET" | "POST"; body?: unknown; bearer?: string }) {
    return driver.http.request({
      surface: "publish",
      method: init.method,
      path,
      headers: init.bearer ? { authorization: `Bearer ${init.bearer}` } : {},
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  }

  function refusalOf(res: { status: number; text: string; json(): unknown }, what: string): Refusal {
    let body: { reason?: string; message?: string; retry_after_s?: number } = {};
    try {
      body = res.json() as typeof body;
    } catch {
      /* reported below */
    }
    if (body.reason && KNOWN_REASONS.has(body.reason)) {
      return new Refusal(body.reason as RefusalReason, {
        ...(body.message === undefined ? {} : { message: body.message }),
        ...(body.retry_after_s === undefined ? {} : { retryAfterS: body.retry_after_s }),
      });
    }
    throw new InfrastructureError(`${what}: the publish Worker answered ${res.status} with no refusal: ${res.text.slice(0, 200)}`);
  }

  const sql = (query: string, params: unknown[] = []) => storage().sql(query, params);

  const runWith = (id: string, view: () => Promise<RunView>) =>
    new Run(
      id,
      view,
      async () => {
        const key = String((await sql("select report_key from validation_runs where id = ?", [id]))[0]?.report_key ?? "");
        const bytes = key ? await storage().reports.get(key) : null;
        return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as ValidationReport) : null;
      },
      async () => {
        const row = (await sql("select tree_hash, canonical_sha256, canonical_key from validation_runs where id = ?", [id]))[0] ?? {};
        const key = row.canonical_key ? String(row.canonical_key) : null;
        return {
          treeHash: row.tree_hash ? String(row.tree_hash) : null,
          canonicalSha256: row.canonical_sha256 ? String(row.canonical_sha256) : null,
          canonical: key ? await storage().reports.get(key) : null,
        };
      },
    );


  async function createPublisher(opts: PublisherHandleOpts = {}): Promise<PublisherHandle> {
    const { verified, ...userOpts } = opts;
    const person = await scopes.publishers.create(userOpts);
    const word = person.scope.name;
    const scope = aliases.alias(word);
    const sql = storage().sql;
    const found = await sql(
      "select u.id as user_id, s.id as scope_id from users u join scopes s on s.name = ? join scope_members m on m.scope_id = s.id and m.user_id = u.id where u.handle = ?",
      [scope, scope],
    );
    const userId = String(found[0]?.user_id ?? "");
    if (!userId) throw new InfrastructureError(`the person ${word} is not a member of their personal scope, so there is nothing to publish to`);
    if (verified) await sql("update scopes set verified_domain = ? where id = ?", [`${scope}.example`, String(found[0]?.scope_id)]);

    const parse = (nameAtVersion: string) => {
      const m = NAME_AT_VERSION.exec(nameAtVersion);
      if (!m) throw new InfrastructureError(`not a pack at a version: ${nameAtVersion}`);
      return { scope: aliases.alias(m[1]!), name: m[2]!, version: m[3]!, word: m[1]! };
    };

    const wizard = (body: Record<string, unknown>) => send("/internal/wizard", { method: "POST", body: { principal_id: userId, ...body } });

    /** The client's side of an upload through the web wizard: a credential, one presigned PUT, and the report that it finished. */
    async function upload(target: { scope: string; name: string; version: string }, archive: ArchiveHandle, dryRun: boolean): Promise<Refusal | { credentialId: string }> {
      const pack = `@${target.scope}/${target.name}`;
      const issued = await wizard({ pack, version: target.version, action: "upload-url", ...(dryRun ? { dry_run: true } : {}) });
      if (issued.status >= 400) return refusalOf(issued, "wizard upload-url");
      const grant = issued.json() as { credential: string; presign_path: string };
      const presigned = await send(grant.presign_path, { method: "POST", body: { content_length: archive.bytes.byteLength }, bearer: grant.credential });
      if (presigned.status >= 400) return refusalOf(presigned, "presign");
      const p = presigned.json() as { url: string; key: string; headers: Record<string, string>; credential_id: string };
      const put: Presigned = { url: p.url, key: p.key, headers: p.headers, credentialId: p.credential_id };
      const stored = await ci.ci.put(put, archive.bytes);
      if (stored instanceof Refusal) return stored;
      const done = await send(grant.presign_path.replace(/\/upload-url$/, "/uploaded"), { method: "POST", body: {}, bearer: grant.credential });
      if (done.status >= 400) return refusalOf(done, "uploaded");
      return { credentialId: p.credential_id };
    }

    const runHandle = (id: string) =>
      runWith(id, async () => {
        const res = await send(`/internal/runs/${id}?principal_id=${encodeURIComponent(userId)}`, { method: "GET" });
        if (res.status !== 200) throw new InfrastructureError(`reading run ${id} answered ${res.status}: ${res.text.slice(0, 200)}`);
        return res.json() as RunView;
      });

    async function start(target: { scope: string; name: string; version: string }, action: "start" | "dry-run", declared: string, credentialId: string, proseScreen = false) {
      await ensureEngines();
      const res = await wizard({
        pack: `@${target.scope}/${target.name}`,
        version: target.version,
        action,
        declared_sha256: declared,
        credential_id: credentialId,
        ...(proseScreen ? { prose_screen: true } : {}),
      });
      if (res.status >= 400) throw refusalOf(res, `wizard ${action}`);
      return runHandle((res.json() as { run_id: string }).run_id);
    }

    const packOf = (target: { scope: string; name: string; word: string }): Pack => {
      const notYet = (verb: string): never => {
        throw new NotImplemented(`pack.${verb}`);
      };
      return {
        name: `@${target.word}/${target.name}`,
        systemName: `@${target.scope}/${target.name}`,
        version: () => notYet("version"),
        versions: () => notYet("versions"),
        latest: () => notYet("latest"),
        as: () => notYet("as"),
        setVisibility: () => notYet("setVisibility"),
      };
    };

    async function stage(given: ArchiveHandle, nameAtVersion: string, o: PublishOptions = {}) {
      if (o.visibility || o.staged) throw new NotImplemented("publish with visibility or staging");
      const target = parse(nameAtVersion);
      const archive = given.asVersion?.(target.version) ?? given;
      const uploaded = await upload(target, archive, false);
      if (uploaded instanceof Refusal) throw uploaded;
      return {
        async start(so: PublishOptions = {}): Promise<AdmittedVersion> {
          const run = await start(target, "start", so.declaredSha256 ?? archive.sha256, uploaded.credentialId);
          return new AdmittedVersion(packOf(target), target.version, run, async () => {
            const rows = await sql("select declared_sha256 from validation_runs where id = ?", [run.id]);
            return String(rows[0]?.declared_sha256);
          }, storage, driver);
        },
      };
    }

    const handle: PublisherHandle = Object.assign(Object.create(person) as ScopeOwner, {
      publish(archive: ArchiveHandle) {
        return {
          async as(nameAtVersion: string, o: PublishOptions = {}): Promise<AdmittedVersion> {
            const staged = await stage(archive, nameAtVersion, o);
            return staged.start({ ...(o.declaredSha256 === undefined ? {} : { declaredSha256: o.declaredSha256 }) });
          },
        };
      },
      upload: (archive: ArchiveHandle, nameAtVersion: string) => stage(archive, nameAtVersion),
      async dryRun(archive: ArchiveHandle, o: { proseScreen?: boolean } = {}): Promise<Run> {
        const target = { scope, name: `dry-run-${archive.sha256.slice(0, 8)}`, version: "0.0.1" };
        const uploaded = await upload(target, archive, true);
        if (uploaded instanceof Refusal) throw uploaded;
        return start(target, "dry-run", archive.sha256, uploaded.credentialId, o.proseScreen);
      },
    }) as unknown as PublisherHandle;
    return handle;
  }

  /** A CI workflow's publish: stages the archive through its credential and starts validation, then reads the run as the principal the registry recorded for it. */
  async function publishFromCi(credential: UploadCredential, archive: ArchiveHandle): Promise<Run> {
    await ensureEngines();
    const staged = await credential.upload(archive.bytes);
    if (staged instanceof Refusal) throw staged;
    const started = await credential.start(archive.sha256);
    if (started instanceof Refusal) throw started;
    return runWith(started.runId, async () => (await credential.viewRun(started.runId)) as RunView);
  }

  return {
    archive: (fixture: string, opts: ArchiveOptions = {}): ArchiveHandle => makeArchive(fixture, opts),
    publishers: { create: createPublisher },
    publishFromCi,
  };
}

export type PublishFlow = ReturnType<typeof createPublishFlow>;
