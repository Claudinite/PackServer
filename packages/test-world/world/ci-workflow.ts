import { createHash } from "node:crypto";
import { DEFAULT_EVENTS, defaultRefs, MAX_UPLOAD_BYTES } from "@packserver/core/publishing";
import { REFUSAL_REASONS } from "@packserver/schema";
import { expect } from "vitest";
import type { Driver, StorageAccess } from "../drivers/driver";
import type { MintOptions } from "../fakes/github-oidc";
import { InfrastructureError } from "./errors";
import { Refusal, type RefusalReason } from "./outcomes";

/** A repository as GitHub knows it: names change, ids do not. */
export class CiRepo {
  constructor(
    public slug: string,
    public id: number,
    public ownerId: number,
  ) {}
  get owner(): string {
    return this.slug.split("/")[0]!;
  }
  /** Same ids, new name: the repository was renamed. */
  rename(slug: string): void {
    this.slug = slug;
  }
  /** Same repository id, new owner: the repository was transferred. */
  transferTo(owner: { slug: string; id: number }): void {
    this.slug = `${owner.slug}/${this.slug.split("/")[1]}`;
    this.ownerId = owner.id;
  }
}

export interface TrustedPublisherSeed {
  /** The scenario's name, `@acme/gcp`. */
  pack: string;
  repo: CiRepo;
  workflow: string;
  environment?: string;
  path: string;
  refs?: string[];
  events?: string[];
  /** Seconds-resolution instant a pending registration lapses. */
  pendingUntil?: string;
}

export interface CiWorkflowOpts {
  repo: CiRepo;
  workflowFile?: string;
  environment?: string;
  ref?: string;
  event?: string;
  job?: string;
  refProtected?: boolean;
  /** The upstream this run is a fork of; the run is still in its own repository. */
  forkOf?: CiRepo;
}

export interface TokenOptions extends MintOptions {
  claims?: Record<string, unknown>;
}

export interface Presigned {
  readonly url: string;
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentialId: string;
}
export interface Staged {
  readonly key: string;
  readonly sizeBytes: number;
}

export interface UploadCredential {
  readonly id: string;
  readonly pack: string;
  readonly version: string;
  readonly expiresAt: string;
  /** Asks for the one presigned PUT this credential buys, optionally naming another pack than the one it is bound to. */
  presign(contentLength: number, against?: { pack?: string; version?: string }): Promise<Presigned | Refusal>;
  /** Tells the system the PUT finished, so it measures the object. */
  complete(): Promise<Staged | Refusal>;
  /** Presigns, PUTs `body` to the URL, and reports the upload complete. */
  upload(body: Uint8Array, against?: { pack?: string; version?: string }): Promise<Staged | Refusal>;
}

export interface CiWorkflow {
  oidcToken(options?: TokenOptions): Promise<string>;
  exchange(pack: string, version: string, over?: { token?: string; job?: string | null; token_options?: TokenOptions }): Promise<UploadCredential | Refusal>;
}

export interface StagedObject {
  key: string;
  size: number;
}

const KNOWN = new Set<string>(REFUSAL_REASONS);
const MiB = 1024 * 1024;

/** Deterministic archive-shaped bytes of an exact size. */
export function archiveBytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** The CI side of publishing: GitHub's token issuer, the workflows that present its tokens, and what lands in staging. */
export function createCi(driver: Driver, alias: (name: string) => string) {
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new InfrastructureError(`the ${driver.kind} driver has no ${what}: CI workflows run only against the in-process world`);
    return value;
  };
  const oidc = () => need(driver.fakes?.oidc, "fake GitHub token issuer");
  const storage = (): StorageAccess => need(driver.storage, "storage access");

  const systemPack = (pack: string): { scope: string; name: string; full: string } => {
    const m = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/.exec(pack);
    if (!m) throw new InfrastructureError(`not a pack name: ${pack}`);
    const scope = alias(m[1]!);
    return { scope, name: m[2]!, full: `@${scope}/${m[2]}` };
  };

  async function toOutcome<T>(res: { status: number; text: string; json(): unknown }, ok: (body: Record<string, unknown>) => T): Promise<T | Refusal> {
    let body: Record<string, unknown> = {};
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      /* a non-JSON body is reported below */
    }
    if (res.status < 400) return ok(body);
    if (typeof body.reason === "string" && KNOWN.has(body.reason)) {
      const diff = body.claim_diff as Record<string, { expected: unknown; actual: unknown }> | undefined;
      return new Refusal(body.reason as RefusalReason, diff ? { claimDiff: diff } : {});
    }
    throw new InfrastructureError(`the publish Worker answered ${res.status} with no refusal: ${res.text.slice(0, 200)}`);
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return driver.http.request({ surface: "publish", method: "POST", path, headers, body });
  }

  function credential(raw: { id: string; secret: string; pack: string; version: string; expiresAt: string }, sys: { scope: string; name: string }): UploadCredential {
    const auth = { authorization: `Bearer ${raw.secret}` };
    const baseFor = (against: { pack?: string; version?: string } = {}) => {
      const target = against.pack ? systemPack(against.pack) : sys;
      return `/api/publish/@${target.scope}/${target.name}/${against.version ?? raw.version}`;
    };
    const self: UploadCredential = {
      id: raw.id,
      pack: raw.pack,
      version: raw.version,
      expiresAt: raw.expiresAt,
      async presign(contentLength, against) {
        const res = await post(`${baseFor(against)}/upload-url`, { content_length: contentLength }, auth);
        return toOutcome(res, (b) => ({ url: String(b.url), key: String(b.key), headers: b.headers as Record<string, string>, credentialId: String(b.credential_id) }));
      },
      async complete() {
        return toOutcome(await post(`${baseFor()}/uploaded`, {}, auth), (b) => ({ key: String(b.key), sizeBytes: Number(b.size_bytes) }));
      },
      async upload(body, against) {
        const presigned = await self.presign(body.byteLength, against);
        if (presigned instanceof Refusal) return presigned;
        const stored = await putTo(presigned, body);
        if (stored instanceof Refusal) return stored;
        return self.complete();
      },
    };
    return self;
  }

  /** The client's own PUT to the presigned URL; a storage refusal is reported as the signature failing, which is what it is. */
  async function putTo(presigned: Presigned, body: Uint8Array, over: { url?: string } = {}): Promise<true | Refusal> {
    const headers = Object.fromEntries(Object.entries(presigned.headers).filter(([k]) => k.toLowerCase() !== "content-length"));
    const res = await fetch(over.url ?? presigned.url, { method: "PUT", headers, body: body as Uint8Array<ArrayBuffer> });
    if (res.ok) return true;
    await res.arrayBuffer();
    return new Refusal("signature");
  }

  /** Tries to open a multipart upload with a URL that was presigned for one PUT. */
  async function startMultipart(presigned: Presigned): Promise<"started" | Refusal> {
    const res = await fetch(`${presigned.url}&uploads=`, { method: "POST" });
    await res.arrayBuffer();
    return res.ok ? "started" : new Refusal("signature");
  }

  return {
    ci: {
      repo: (slug: string, ids: { id: number; ownerId: number }) => new CiRepo(slug, ids.id, ids.ownerId),

      /** Writes a registration straight into the registry, the way T-035's verb will when it lands. */
      async seedTrustedPublisher(seed: TrustedPublisherSeed): Promise<void> {
        const sys = systemPack(seed.pack);
        const sql = storage().sql;
        const now = new Date(await driver.fakes!.clock.call<number>("now")).toISOString();
        await sql("insert or ignore into scopes (id, name, kind, state, created_at) values (?, ?, 'org', 'active', ?)", [`scope-${sys.scope}`, sys.scope, now]);
        await sql(
          `insert into trusted_publishers (id, scope_id, pack_name, repository_id, repository_owner_id, repository, workflow, environment, path, refs, events, pending_until, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `tp-${crypto.randomUUID()}`, `scope-${sys.scope}`, sys.name, String(seed.repo.id), String(seed.repo.ownerId), seed.repo.slug, seed.workflow,
            seed.environment ?? null, seed.path, JSON.stringify(seed.refs ?? defaultRefs(sys.name, "main")), JSON.stringify(seed.events ?? DEFAULT_EVENTS),
            seed.pendingUntil ?? null, now, now,
          ],
        );
      },

      workflow(opts: CiWorkflowOpts): CiWorkflow {
        const workflowFile = opts.workflowFile ?? ".github/workflows/publish.yml";
        const self: CiWorkflow = {
          async oidcToken(options = {}) {
            const { repo } = opts;
            const ref = opts.ref ?? "refs/tags/gcp/1.0.0";
            const claims: Record<string, unknown> = {
              sub: opts.environment ? `repo:${repo.slug}:environment:${opts.environment}` : `repo:${repo.slug}:ref:${ref}`,
              repository: repo.slug,
              repository_id: String(repo.id),
              repository_owner: repo.owner,
              repository_owner_id: String(repo.ownerId),
              ref,
              ref_protected: String(opts.refProtected ?? true),
              job_workflow_ref: `${repo.slug}/${workflowFile}@${ref}`,
              event_name: opts.event ?? "push",
              sha: "a".repeat(40),
              run_id: "1001",
              jti: crypto.randomUUID(),
              ...(opts.environment ? { environment: opts.environment } : {}),
              ...options.claims,
            };
            return oidc().mint(claims, options);
          },
          async exchange(pack, version, over = {}) {
            const sys = systemPack(pack);
            const token = over.token ?? (await self.oidcToken(over.token_options));
            const job = over.job === undefined ? (opts.job ?? "publish") : over.job;
            const res = await post("/api/oidc/exchange", { token, pack: sys.full, version, ...(job === null ? {} : { job }) });
            return toOutcome(res, (b) => credential({ id: String(b.credential_id), secret: String(b.credential), pack, version, expiresAt: String(b.expires_at) }, sys));
          },
        };
        return self;
      },

      /** PUTs bytes to a URL the system presigned, optionally to a different address: the client's half, with nothing the Worker could check. */
      put: putTo,
      startMultipart,

      issuer: {
        keyIds: () => oidc().keyIds(),
        addKey: () => oidc().addKey(),
        removeKey: (kid: string) => oidc().removeKey(kid),
        jwksFetches: () => oidc().jwksFetches(),
        mintUnpublished: (claims: Record<string, unknown>) => oidc().mintUnpublished(claims),
      },

      staging: {
        async objects(scope: string): Promise<StagedObject[]> {
          return (await storage().staging.list(`staging/${alias(scope)}/`)).sort((a, b) => a.key.localeCompare(b.key));
        },
        async sha256(key: string): Promise<string> {
          const bytes = await storage().staging.get(key);
          if (!bytes) throw new InfrastructureError(`no staged object ${key}`);
          return createHash("sha256").update(bytes).digest("hex");
        },
        /** Stages `mib` mebibytes the way a publisher does, in objects of at most 3 MiB, each through its own credential. */
        async fill(workflow: CiWorkflow, pack: string, mib: number): Promise<void> {
          let remaining = mib * MiB;
          for (let i = 0; remaining > 0; i++) {
            const size = Math.min(MAX_UPLOAD_BYTES, remaining);
            const credential = await workflow.exchange(pack, `0.0.${i}`);
            if (credential instanceof Refusal) throw new InfrastructureError(`filling staging was refused at object ${i}: ${credential.reason}`);
            const staged = await credential.upload(archiveBytes(size, i));
            if (staged instanceof Refusal) throw new InfrastructureError(`filling staging was refused at object ${i}: ${staged.reason}`);
            remaining -= size;
          }
        },
      },
    },
  };
}

export type CiModule = ReturnType<typeof createCi>;

/** A value the system should have accepted: fails the scenario if it is a refusal, and narrows the type if not. */
export function accepted<T>(value: T | Refusal): T {
  expect(value).not.toBeRefused();
  return value as T;
}
