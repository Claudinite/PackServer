// In-process driver: both Workers run in one workerd under wrangler's
// createTestHarness; every outbound fetch goes through Node's global fetch,
// where MSW answers with the fakes and errors on anything unhandled.
import { createTestHarness, type TestHarness } from "wrangler";
import { Agent, setGlobalDispatcher } from "undici";
import type { SetupServer } from "msw/node";
import { createFakes, type Fakes } from "../fakes/fakes";
import { mswTransport } from "../fakes/transports";
import { Recorder } from "../world/recorder";
import type { Driver } from "./driver";
import { HttpProtocol } from "./protocol";

const ROOT = new URL("../..", import.meta.url).pathname;
const OIDC_ISSUER = "https://oidc.test";
const LLM_URL = "https://llm.test/validate";
const REC_PREFIX = "@@REC ";

export type InProcessOptions = { llmUrl?: string };

export class InProcessDriver implements Driver {
  constructor(private readonly opts: InProcessOptions = {}) {}
  readonly kind = "inprocess" as const;
  readonly recorder = new Recorder();
  // ISOLATION=aliases skips the per-scenario storage reset and relies on unique names only (faster; measured in RESULTS.md).
  private readonly resetPerScenario = (process.env.ISOLATION ?? "reset") === "reset";
  readonly capabilities = { recorder: true, reset: this.resetPerScenario };
  fakes!: Fakes;
  private server!: TestHarness;
  private net!: SetupServer;
  private protocol!: HttpProtocol;
  private logCursor = 0;

  async start(): Promise<void> {
    this.fakes = await createFakes(this.recorder, { oidcIssuer: OIDC_ISSUER, llmUrl: LLM_URL });
    this.net = mswTransport(this.fakes.handlers);
    // Gotcha: importing `wrangler` installs undici's EnvHttpProxyAgent as the global dispatcher when
    // HTTPS_PROXY is set. MSW 3 hooks at the dispatcher level and would then see CONNECT frames
    // ("oidc.test:443") instead of requests. Workers' egress must never touch a real proxy anyway.
    setGlobalDispatcher(new Agent());
    // The rule "every outside dependency is faked", enforced: an unfaked egress fails the scenario.
    this.net.listen({ onUnhandledFrame: "error" }); // msw 3 name; msw 2 called it onUnhandledRequest

    this.server = createTestHarness({
      root: ROOT,
      workers: [
        { configPath: "workers/web/wrangler.jsonc", vars: { OIDC_ISSUER, LLM_URL: this.opts.llmUrl ?? LLM_URL } }, // primary
        // MCP_PREBUILT_DIR lets the N/N-1 compatibility run swap in an older build of one Worker.
        { configPath: "workers/mcp/wrangler.jsonc", ...(process.env.MCP_PREBUILT_DIR ? { prebuiltWorkerDir: process.env.MCP_PREBUILT_DIR } : {}) },
      ],
    });
    await this.server.listen();
    await this.migrate();
    this.protocol = new HttpProtocol({
      web: (path, init) => this.server.fetch(path, init as any) as unknown as Promise<Response>,
      mcp: (path, init) => this.server.fetch(`http://mcp.test${path}`, init as any) as unknown as Promise<Response>,
    });
  }

  private async migrate(): Promise<void> {
    await this.server.getWorker("web").applyD1Migrations("DB");
  }

  async reset(): Promise<string | void> {
    let note: string | undefined;
    if (this.resetPerScenario) {
      const t0 = performance.now();
      await this.server.reset(); // storage is recreated; the harness URL may change
      const t1 = performance.now();
      await this.migrate();
      note = `harness.reset=${(t1 - t0).toFixed(0)}ms migrate=${(performance.now() - t1).toFixed(0)}ms`;
    }
    this.server.clearLogs();
    this.logCursor = 0;
    this.recorder.clear();
    this.fakes.llm.reset();
    return note;
  }

  diagnostics() {
    return { mcpBuilds: [...(this.protocol?.seenBuilds ?? [])] };
  }

  /** Pull the Workers' own invocation records out of the captured runtime logs. */
  async settle(): Promise<void> {
    const logs = this.server.getLogs();
    for (const log of logs.slice(this.logCursor)) {
      const i = log.message.indexOf(REC_PREFIX);
      if (i === -1) continue;
      const rec = JSON.parse(log.message.slice(i + REC_PREFIX.length));
      this.recorder.add({ ...rec, seenBy: "worker" });
    }
    this.logCursor = logs.length;
  }

  async stop(): Promise<void> {
    this.net.close();
    await this.server.close();
  }

  signIn: Driver["signIn"] = (t) => this.protocol.signIn(t);
  publish: Driver["publish"] = (s, p) => this.protocol.publish(s, p);
  viewPack: Driver["viewPack"] = (s, n) => this.protocol.viewPack(s, n);
  downloadArchive: Driver["downloadArchive"] = (s, n) => this.protocol.downloadArchive(s, n);
  searchAsAgent: Driver["searchAsAgent"] = (q) => this.protocol.searchAsAgent(q);
  searchOnSite: Driver["searchOnSite"] = (q) => this.protocol.searchOnSite(q);
}
