import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fixtureArchive, type FixtureName } from "@packserver/core/canonical/fixtures";
import type { Driver } from "../drivers/driver";
import type { Aliases } from "./alias";
import type { CiModule, Presigned } from "./ci-workflow";
import { InfrastructureError, NotImplemented, stubModule } from "./errors";
import { Refusal, type RefusalReason } from "./outcomes";
import type { UsersModule } from "./areas/users";
import type { Archive, Pack, PublisherOpts, Scope, User, ValidationRun, Version, VersionStatus, Verification } from "./types";
import type { ValidationModule } from "./areas/validation";

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

/** One validation run as its publisher sees it; every read asks the system again. */
export class Run implements ValidationRun {
  constructor(
    readonly id: string,
    private readonly fetchView: () => Promise<RunView>,
  ) {}
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

export interface PublisherHandleOpts extends PublisherOpts {
  /** The scope's name as the scenario spells it; default is the person's own name. */
  scope?: string;
}

export interface PublishOptions {
  visibility?: "private";
  staged?: true;
  /** The sha256 the publisher declares; default is the archive's own. */
  declaredSha256?: string;
}

export interface PublisherHandle extends Omit<User, "as" | "from" | "failingHumanCheck"> {
  readonly scope: Scope;
  publish(archive: ArchiveHandle): { as(nameAtVersion: string, o?: PublishOptions): Promise<AdmittedVersion> };
  dryRun(archive: ArchiveHandle, o?: { proseScreen?: boolean }): Promise<Run>;
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
export function createPublishFlow(driver: Driver, aliases: Aliases, users: UsersModule, ci: CiModule) {
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

  async function createPublisher(opts: PublisherHandleOpts = {}): Promise<PublisherHandle> {
    const person = await users.users.create();
    const word = opts.scope ?? person.handle;
    const scope = aliases.alias(word);
    const now = new Date(await driver.fakes!.clock.call<number>("now")).toISOString();
    const sql = storage().sql;
    const userId = String((await sql("select id from users where handle = ?", [aliases.alias(person.handle)]))[0]?.id ?? "");
    if (!userId) throw new InfrastructureError(`the person ${person.handle} has no account row to publish from`);
    await sql(
      "insert into scopes (id, name, kind, state, created_at, verified_domain) values (?, ?, 'user', 'active', ?, ?)",
      [`scope-${scope}`, scope, now, opts.verified ? `${scope}.example` : null],
    );
    await sql("insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, 'owner', ?)", [`scope-${scope}`, userId, now]);

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
      new Run(id, async () => {
        const res = await send(`/internal/runs/${id}?principal_id=${encodeURIComponent(userId)}`, { method: "GET" });
        if (res.status !== 200) throw new InfrastructureError(`reading run ${id} answered ${res.status}: ${res.text.slice(0, 200)}`);
        return res.json() as RunView;
      });

    async function start(target: { scope: string; name: string; version: string }, action: "start" | "dry-run", declared: string, credentialId: string, proseScreen = false) {
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

    const handle: PublisherHandle = Object.assign(Object.create(person) as User, {
      scope: { name: word },
      publish(archive: ArchiveHandle) {
        return {
          async as(nameAtVersion: string, o: PublishOptions = {}): Promise<AdmittedVersion> {
            if (o.visibility || o.staged) throw new NotImplemented("publish with visibility or staging");
            const target = parse(nameAtVersion);
            const uploaded = await upload(target, archive, false);
            if (uploaded instanceof Refusal) throw uploaded;
            const run = await start(target, "start", o.declaredSha256 ?? archive.sha256, uploaded.credentialId);
            return new AdmittedVersion(packOf(target), target.version, run, async () => {
              const rows = await sql("select declared_sha256 from validation_runs where id = ?", [run.id]);
              return String(rows[0]?.declared_sha256);
            });
          },
        };
      },
      async dryRun(archive: ArchiveHandle, o: { proseScreen?: boolean } = {}): Promise<Run> {
        const target = { scope, name: `dry-run-${archive.sha256.slice(0, 8)}`, version: "0.0.1" };
        const uploaded = await upload(target, archive, true);
        if (uploaded instanceof Refusal) throw uploaded;
        return start(target, "dry-run", archive.sha256, uploaded.credentialId, o.proseScreen);
      },
    }) as unknown as PublisherHandle;
    return handle;
  }

  const validationStub = stubModule<ValidationModule>("validation").validation;
  const validation: ValidationModule["validation"] = new Proxy(validationStub, {
    get(target, key, receiver) {
      if (key === "of") {
        return async (version: Version): Promise<ValidationRun> => {
          if (!(version instanceof AdmittedVersion)) throw new InfrastructureError("validation.of needs a version a publish returned");
          return version.run;
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });

  return {
    archive: (fixture: string, opts: ArchiveOptions = {}): ArchiveHandle => makeArchive(fixture, opts),
    publishers: { create: createPublisher },
    validation,
  };
}

export type PublishFlow = ReturnType<typeof createPublishFlow>;
