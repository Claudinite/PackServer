import type { WorkerName } from "@packserver/ports";
import type { WorldFakes } from "../fakes/compose";
import type { InvocationFilter, InvocationView } from "../world/recorder";
import type { McpClient } from "./mcp";

export type DriverKind = "inprocess" | "http" | "browser" | "mcp";

/** What a driver can offer; a scenario that needs more is skipped with the reason, never passed. */
export type Capability = "fakes" | "clock" | "reset" | "recorder" | "mcp" | "ui" | "telemetry" | "storage" | "selftest";

export interface ApiRequest {
  /** Which Worker answers in-process; ignored by a driver that reaches the system through one public host. */
  surface: WorkerName;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sent as an outsider would send it: a driver that signs its requests leaves this one unsigned. */
  unsigned?: boolean;
  /** The key id a signing driver signs this request as, so the call spends that principal's self-test budget. */
  signAs?: string;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  json(): unknown;
}

export interface McpCredentials {
  bearer?: string;
}

export interface UiActions {
  /** Opens a page in the driver's browser; the browser driver is the only code that knows selectors. */
  open(path: string): Promise<{ title: string; status: number }>;
}

/** Direct reach into the in-process stores, for seeding what another area's verbs will one day create and for reading what a bucket holds. */
export interface PackBucket {
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<{ size: number; httpMetadata?: SeedObjectMetadata } | null>;
  list(prefix: string): Promise<string[]>;
}

export interface StorageAccess {
  /** Runs one statement against the registry database. */
  sql(statement: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  staging: {
    list(prefix: string): Promise<Array<{ key: string; size: number }>>;
    get(key: string): Promise<Uint8Array | null>;
    delete(key: string): Promise<void>;
  };
  /** What the validator wrote to `validation-reports`: the report, the sandbox output, the canonical archive. */
  reports: {
    list(prefix: string): Promise<string[]>;
    get(key: string): Promise<Uint8Array | null>;
  };
  /** Puts a message on the registry's reindex queue, as the Worker that noticed a proof change does. */
  reindex: { send(message: unknown): Promise<void> };
  /** What promotion wrote to the public and private pack buckets. */
  packs: { public: PackBucket; private: PackBucket };
  /** The engine release mirror in R2 `ops`, which a release workflow fills in production. */
  ops: {
    put(key: string, value: Uint8Array | string): Promise<void>;
  };
}

export interface SeedObjectMetadata {
  contentType?: string;
  contentDisposition?: string;
  cacheControl?: string;
}
/** The slice of the registry's storage a scenario may write directly, for state the owning task has not yet built a verb for. */
export interface SeedStorage {
  db: {
    prepare(sql: string): { bind(...values: unknown[]): unknown };
    batch(statements: unknown[]): Promise<unknown[]>;
  };
  packsPublic: SeedBucket;
  packsPrivate: SeedBucket;
  /** The `ops` bucket the zone's Logpush jobs deliver to; absent when the admin Worker is not booted. */
  ops?: OpsBucket;
}
export interface OpsBucket {
  put(key: string, value: Uint8Array | string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}
export interface SeedBucket {
  put(key: string, value: Uint8Array | string, options?: { httpMetadata?: SeedObjectMetadata }): Promise<unknown>;
  head(key: string): Promise<{ size: number; httpMetadata?: SeedObjectMetadata } | null>;
}

export interface Driver {
  readonly kind: DriverKind;
  readonly capabilities: ReadonlySet<Capability>;
  /** Distinguishes runs that share one deployment; absent when each run has its own world. */
  readonly aliasSalt?: string;
  /** The Workers a request can be addressed to. */
  readonly surfaces: readonly WorkerName[];
  http: { request(req: ApiRequest): Promise<ApiResponse> };
  ui?: UiActions;
  /** In-process only: D1 and the pack buckets, as the Workers see them. */
  storage?(): Promise<SeedStorage>;
  mcp?: { client(credentials?: McpCredentials): Promise<McpClient> };
  fakes?: WorldFakes;
  publishStorage?: StorageAccess;
  recorder?: { invocations(filter?: InvocationFilter): InvocationView[]; clear(): void };
  /** Every release id seen on a response (REQ-OPS-006). */
  observedVersions(): ReadonlySet<string>;
  /** The release id the system under test is expected to answer with. */
  deployedVersion(): string;
  start(): Promise<void>;
  /** Once per file: storage recreated and migrations applied. */
  reset(): Promise<void>;
  /** Before every scenario: fake state, handlers, recorder and clock return to their starting point. */
  beginScenario(): Promise<void>;
  /** Failure attachments, with credentials already stripped. */
  diagnostics(): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}
