import type { WorkerName } from "@packserver/ports";
import type { WorldFakes } from "../fakes/compose";
import type { InvocationFilter, InvocationView } from "../world/recorder";
import type { McpClient } from "./mcp";

export type DriverKind = "inprocess" | "http" | "browser" | "mcp";

/** What a driver can offer; a scenario that needs more is skipped with the reason, never passed. */
export type Capability = "fakes" | "clock" | "reset" | "recorder" | "mcp" | "ui" | "telemetry";

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

export interface Driver {
  readonly kind: DriverKind;
  readonly capabilities: ReadonlySet<Capability>;
  /** Distinguishes runs that share one deployment; absent when each run has its own world. */
  readonly aliasSalt?: string;
  /** The Workers a request can be addressed to. */
  readonly surfaces: readonly WorkerName[];
  http: { request(req: ApiRequest): Promise<ApiResponse> };
  ui?: UiActions;
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
