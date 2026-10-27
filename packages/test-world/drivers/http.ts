import type { WorkerName } from "@packserver/ports";
import { InfrastructureError } from "../world/errors";
import type { ApiRequest, ApiResponse, Capability, Driver, McpCredentials } from "./driver";
import { readHttpEnv, type HttpEnv } from "./http-env";
import { reachRequest } from "./http/runtime-neutral";
import { McpClient } from "./mcp";
import { encodeBody, toApiResponse, VersionObserver } from "./observe";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The same World against a URL: no fakes, no clock, no reset, no recorder. The system is one
 * public host, so a request's `surface` does not choose a destination.
 */
export class HttpDriver implements Driver {
  readonly kind = "http" as const;
  /** The self-test answers a caller only with a credential the driver signs with. */
  readonly capabilities: ReadonlySet<Capability>;
  readonly surfaces: readonly WorkerName[] = ["web"];
  readonly aliasSalt = crypto.randomUUID().slice(0, 8);
  private readonly versions: VersionObserver;

  constructor(
    private readonly env: HttpEnv = readHttpEnv(),
    private readonly doFetch: Fetch = fetch,
  ) {
    this.versions = new VersionObserver(env.expectedReleases);
    this.capabilities = new Set<Capability>(env.selfTest ? ["mcp", "selftest"] : ["mcp"]);
  }

  get probeTenant(): string {
    return this.env.probeTenant;
  }

  http = {
    request: async (req: ApiRequest): Promise<ApiResponse> => {
      const { url, headers } = await reachRequest(this.env, req, { nowMs: Date.now(), nonce: crypto.randomUUID() });
      const body = encodeBody(req.body, headers);
      const res = await this.doFetch(url.toString(), { method: req.method, headers, redirect: "manual", ...(body === undefined ? {} : { body }) });
      const out = await toApiResponse(res);
      this.versions.check(url.toString(), out);
      return out;
    },
  };

  mcp = { client: async (credentials?: McpCredentials) => new McpClient((req) => this.http.request(req), credentials) };

  observedVersions() {
    return this.versions.observed;
  }
  deployedVersion(): string {
    const [first] = this.env.expectedReleases ?? [];
    if (!first) throw new InfrastructureError("the http driver knows the deployed release only when PACKSERVER_EXPECTED_RELEASE names it");
    return first;
  }

  async start(): Promise<void> {
    // A path nothing serves: the home page reads the catalogue, which is legitimately unavailable before the first reset.
    const res = await this.http.request({ surface: "web", method: "GET", path: "/no/such/path" });
    if (res.status >= 500) throw new InfrastructureError(`${this.env.baseUrl.host} answered ${res.status}`);
  }
  async reset(): Promise<void> {}
  async beginScenario(): Promise<void> {}
  async diagnostics(): Promise<Record<string, unknown>> {
    return { driver: this.kind, host: this.env.baseUrl.host, observedVersions: [...this.versions.observed] };
  }
  async dispose(): Promise<void> {}
}
