import type { Finding, RESPONSE_HEADER_ALLOWLIST, QuotaRpc, RootCoordinatorRpc, ScopeCoordinatorRpc } from "@packserver/schema";

export class PortError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PortError";
  }
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface Rng {
  float(): number;
  uuid(): string;
  bytes(length: number): Uint8Array;
}

export interface GitHubRepo {
  slug: string;
  id: number;
  default_branch: string;
  private: boolean;
  archived: boolean;
}
export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

/** Read endpoints only: every method starts with `get` or `search`, and a test holds the type to that. */
export interface GitHub {
  getRepo(slug: string): Promise<GitHubRepo | null>;
  getRef(slug: string, ref: string): Promise<{ sha: string } | null>;
  getTree(slug: string, sha: string): Promise<GitHubTreeEntry[]>;
  getBlob(slug: string, sha: string): Promise<Uint8Array | null>;
  getFile(slug: string, ref: string, path: string): Promise<Uint8Array | null>;
  searchCode(query: string): Promise<Array<{ repo: string; path: string }>>;
}

export interface OidcClaims {
  iss: string;
  aud: string;
  sub: string;
  repository: string;
  repository_owner: string;
  repository_id: string;
  ref: string;
  ref_protected: string;
  job_workflow_ref: string;
  event_name: string;
  run_id: string;
  jti: string;
  iat: number;
  exp: number;
}
export interface OidcVerifier {
  /** Rejects with a `PortError` on a bad signature, issuer, audience or expiry. */
  verify(token: string, options: { audience: string }): Promise<OidcClaims>;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, string | number | boolean>;
}
export interface VectorIndex {
  upsert(items: Array<{ id: string; vector: number[]; metadata?: VectorMatch["metadata"] }>): Promise<void>;
  query(vector: number[], options: { topK: number }): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SandboxAReport {
  tree_hash: string;
  canonical_key: string;
  file_count: number;
  findings: Finding[];
}
export interface SandboxBReport {
  loaded: boolean;
  round_trip_ok: boolean;
  checks: Array<{ name: string; outcome: "pass" | "warn" | "hold" | "fail" }>;
  egress_attempts: string[];
  findings: Finding[];
}
export interface Sandbox {
  /** Container A: bounded extraction and canonical re-pack. */
  inspect(request: { archive_key: string }): Promise<SandboxAReport>;
  /** Container B: load and run the canonical pack. */
  run(request: { canonical_key: string; tree_hash: string }): Promise<SandboxBReport>;
}

export interface ProseScreenRequest {
  nonce: string;
  chunks: Array<{ id: string; text: string }>;
}
export interface ProseScreenResult {
  implementation: string;
  model_version: string | null;
  chunks: Array<{ id: string; probabilities: Record<string, number> }>;
}
export interface ProseScreen {
  screen(request: ProseScreenRequest): Promise<ProseScreenResult>;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
export interface Mail {
  send(message: MailMessage): Promise<{ id: string }>;
}

export interface Dns {
  resolveTxt(name: string): Promise<string[]>;
}

export interface Turnstile {
  verify(token: string, remoteIp?: string): Promise<{ success: boolean; codes: string[] }>;
}

export interface AccessIdentityClaims {
  email: string;
  sub: string;
}
export interface AccessIdentity {
  /** Rejects with a `PortError` when the assertion's signature or audience does not verify. */
  verify(assertion: string): Promise<AccessIdentityClaims>;
}

export interface StatsPoint {
  name: string;
  blobs: string[];
  doubles: number[];
  index?: string;
}
/** The secrets telemetry hashes under and the `telemetry_mode` flag, read through the Worker's bindings. */
export interface TelemetryConfig {
  /** A key whose secret cannot be read is absent; the hash it would make is then left out of the event. */
  keys(): Promise<{ ipMaster?: string; principalKey?: string }>;
  mode(): Promise<"normal" | "economy">;
}

export interface Stats {
  write(point: StatsPoint): void;
}

/** A cached response keeps only the allowlisted response headers. */
export type CacheHeaders = { [H in (typeof RESPONSE_HEADER_ALLOWLIST)[number]]?: string };
export interface CacheEntry {
  status: number;
  headers: CacheHeaders;
  body: Uint8Array;
}
export interface Cache {
  get(url: string): Promise<CacheEntry | null>;
  put(url: string, entry: CacheEntry): Promise<void>;
  purge(url: string): Promise<boolean>;
}

export interface UploadTicket {
  key: string;
  url: string;
  expires_at: number;
}
export interface Uploads {
  create(request: { key: string; max_bytes: number; content_type: string }): Promise<UploadTicket>;
  stat(key: string): Promise<{ size: number; sha256: string } | null>;
  read(key: string): Promise<Uint8Array | null>;
}

export interface AuditEntry {
  seq: number;
  prev_hash: string;
  hash: string;
  event: Record<string, unknown>;
}
export interface AuditSink {
  /** Appends one event to the hash chain. */
  append(event: Record<string, unknown>): Promise<AuditEntry>;
  head(): Promise<{ seq: number; hash: string } | null>;
}

export interface Transparency {
  anchor(head: { seq: number; hash: string }): Promise<{ log_index: number; anchored_hash: string }>;
}

export interface D1Result {
  rows: Array<Record<string, unknown>>;
  meta: { changes: number; last_row_id: number | null };
}
export interface D1 {
  query(sql: string, params?: unknown[]): Promise<D1Result>;
  batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<D1Result[]>;
}

export interface R2 {
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, body: Uint8Array, options?: { content_type?: string }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** A bucket a Worker may only read: the type has no write method, so a write cannot be written. */
export type R2Read = Pick<R2, "get" | "head" | "list">;

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { ttl_seconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface Queue {
  send(message: unknown): Promise<void>;
  sendBatch(messages: unknown[]): Promise<void>;
}

export interface Workflow {
  create(request: { id?: string; params: unknown }): Promise<{ id: string }>;
  status(id: string): Promise<{ status: string }>;
}

export interface RateLimit {
  limit(request: { key: string }): Promise<{ success: boolean }>;
}

export interface DoRpcs {
  ScopeCoordinator: ScopeCoordinatorRpc;
  Quota: QuotaRpc;
  RootCoordinator: RootCoordinatorRpc;
}
export type DoNamespace = keyof DoRpcs;
export type DoMethod<D extends DoNamespace> = keyof DoRpcs[D] & string;
export type DoArgs<D extends DoNamespace, M extends DoMethod<D>> = DoRpcs[D][M] extends (...a: infer A) => unknown ? A : never;
export type DoResult<D extends DoNamespace, M extends DoMethod<D>> = DoRpcs[D][M] extends (...a: never[]) => infer R
  ? Awaited<R>
  : never;

/** Typed by the schema's RPC contract; every result carries `schema_version`. */
export interface DurableObjects {
  call<D extends DoNamespace, M extends DoMethod<D>>(
    namespace: D,
    name: string,
    method: M,
    args: DoArgs<D, M>,
  ): Promise<DoResult<D, M>>;
}

/** Ports with exactly one instance per Worker. */
export interface SinglePorts {
  clock: Clock;
  rng: Rng;
  github: GitHub;
  oidc: OidcVerifier;
  vectors: VectorIndex;
  embedder: Embedder;
  sandbox: Sandbox;
  proseScreen: ProseScreen;
  mail: Mail;
  dns: Dns;
  turnstile: Turnstile;
  access: AccessIdentity;
  stats: Stats;
  telemetry: TelemetryConfig;
  cache: Cache;
  uploads: Uploads;
  audit: AuditSink;
  transparency: Transparency;
  d1: D1;
  durableObjects: DurableObjects;
}

/** Ports a Worker holds once per binding; the record names the binding as its target. */
export interface BindingPorts {
  r2: R2;
  kv: KV;
  queues: Queue;
  workflows: Workflow;
  rateLimits: RateLimit;
}

export type Ports = SinglePorts & { [K in keyof BindingPorts]: Readonly<Record<string, BindingPorts[K]>> };
