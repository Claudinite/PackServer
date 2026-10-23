import type { WorkerName } from "@packserver/ports";
import type { WorldFakes } from "../fakes/compose";
import type { InvocationFilter, InvocationView } from "../world/recorder";
import type { McpClient } from "./mcp";

export type DriverKind = "inprocess" | "http" | "browser" | "mcp";

/** What a driver can offer; a scenario that needs more is skipped with the reason, never passed. */
export type Capability = "fakes" | "clock" | "reset" | "recorder" | "mcp" | "ui" | "telemetry" | "storage";

export interface ApiRequest {
  /** Which Worker answers in-process; ignored by a driver that reaches the system through one public host. */
  surface: WorkerName;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
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
}
export interface SeedBucket {
  put(key: string, value: Uint8Array | string, options?: { httpMetadata?: SeedObjectMetadata }): Promise<unknown>;
  head(key: string): Promise<{ size: number; httpMetadata?: SeedObjectMetadata } | null>;
}

export interface Driver {
  readonly kind: DriverKind;
  readonly capabilities: ReadonlySet<Capability>;
  /** The Workers a request can be addressed to. */
  readonly surfaces: readonly WorkerName[];
  http: { request(req: ApiRequest): Promise<ApiResponse> };
  ui?: UiActions;
  /** In-process only: D1 and the pack buckets, as the Workers see them. */
  storage?(): Promise<SeedStorage>;
  mcp?: { client(credentials?: McpCredentials): Promise<McpClient> };
  fakes?: WorldFakes;
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
