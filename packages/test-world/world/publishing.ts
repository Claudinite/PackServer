import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fixtureArchive, type FixtureName } from "@packserver/core/canonical/fixtures";
import type { Driver } from "../drivers/driver";
import type { Aliases } from "./alias";
import type { CiModule, Presigned, UploadCredential } from "./ci-workflow";
import { InfrastructureError, NotImplemented } from "./errors";
import type { Finding, ValidationReport } from "@packserver/schema";
import { Refusal, type RefusalReason } from "./outcomes";
import type { ScopeOwner, ScopesModule } from "./areas/scopes";
import type { Archive, Pack, PublisherOpts, UserOpts, ValidationRun, Version, VersionStatus, Verification } from "./types";

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
}

export interface RunMilestone {
  step: string;
  outcome: "ok" | "fail" | "skipped";
  detail?: string;
  at: string;
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

/** What a publish returns before promotion exists: the version as admitted, with the run that validates it. */
export class AdmittedVersion implements Version {
  constructor(
    readonly pack: Pack,
    readonly version: string,
    readonly run: Run,
    private readonly declaredSha256: () => Promise<string>,
  ) {}
  /** The hash the registry holds for this version: the one its admitted run declared. */
  sha256(): Promise<string> {
    return this.declaredSha256();
  }
  private missing(verb: string): never {
    throw new NotImplemented(`version.${verb}`);
  }
  status(): Promise<VersionStatus> {
    return this.missing("status");
  }
  approve(): Promise<void> {
    return this.missing("approve");
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
  verification(): Promise<Verification> {
    return this.missing("verification");
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
  return { fixture, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
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

    async function stage(archive: ArchiveHandle, nameAtVersion: string, o: PublishOptions = {}) {
      if (o.visibility || o.staged) throw new NotImplemented("publish with visibility or staging");
      const target = parse(nameAtVersion);
      const uploaded = await upload(target, archive, false);
      if (uploaded instanceof Refusal) throw uploaded;
      return {
        async start(so: PublishOptions = {}): Promise<AdmittedVersion> {
          const run = await start(target, "start", so.declaredSha256 ?? archive.sha256, uploaded.credentialId);
          return new AdmittedVersion(packOf(target), target.version, run, async () => {
            const rows = await sql("select declared_sha256 from validation_runs where id = ?", [run.id]);
            return String(rows[0]?.declared_sha256);
          });
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
