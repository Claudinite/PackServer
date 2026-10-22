// HTTP driver: the system runs elsewhere (`npm run dev` = wrangler dev with both
// Workers), the fakes listen on a real port the Workers were pointed at, and
// isolation comes from unique names per scenario rather than from a storage reset.
import type { Server } from "node:http";
import { createFakes, type Fakes } from "../fakes/fakes";
import { listeningTransport } from "../fakes/transports";
import { Recorder } from "../world/recorder";
import type { Driver } from "./driver";
import { HttpProtocol } from "./protocol";

export const FAKES_PORT = Number(process.env.FAKES_PORT ?? 9797);
export const FAKE_HOSTS = {
  oidcIssuer: `http://127.0.0.1:${FAKES_PORT}/oidc`,
  llmUrl: `http://127.0.0.1:${FAKES_PORT}/llm/validate`,
};

export class HttpDriver implements Driver {
  readonly kind = "http" as const;
  readonly recorder = new Recorder();
  readonly capabilities = { recorder: false, reset: false };
  fakes!: Fakes;
  private fakeServer!: Server;
  private protocol!: HttpProtocol;

  constructor(
    private readonly webUrl = process.env.WEB_URL ?? "http://127.0.0.1:8787",
    private readonly mcpUrl = process.env.MCP_URL ?? "http://127.0.0.1:8788",
  ) {}

  async start(): Promise<void> {
    this.fakes = await createFakes(this.recorder, FAKE_HOSTS);
    this.fakeServer = await listeningTransport(this.fakes.handlers, FAKES_PORT);
    this.protocol = new HttpProtocol({
      web: (path, init) => fetch(this.webUrl + path, init),
      mcp: (path, init) => fetch(this.mcpUrl + path, init),
    });
    for (const [name, url] of [["web", this.webUrl], ["mcp", this.mcpUrl]]) {
      const res = await fetch(`${url}/health`).catch((e) => { throw new Error(`${name} not reachable at ${url} (start it with: npm run dev): ${e}`); });
      if (!res.ok) throw new Error(`${name} unhealthy at ${url}: ${res.status}`);
    }
  }
  async reset(): Promise<void> {
    this.recorder.clear();
    this.fakes.llm.reset();
  }
  diagnostics() {
    return { mcpBuilds: [...(this.protocol?.seenBuilds ?? [])] };
  }
  async settle(): Promise<void> {}
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.fakeServer.close(() => r()));
  }

  signIn: Driver["signIn"] = (t) => this.protocol.signIn(t);
  publish: Driver["publish"] = (s, p) => this.protocol.publish(s, p);
  viewPack: Driver["viewPack"] = (s, n) => this.protocol.viewPack(s, n);
  downloadArchive: Driver["downloadArchive"] = (s, n) => this.protocol.downloadArchive(s, n);
  searchAsAgent: Driver["searchAsAgent"] = (q) => this.protocol.searchAsAgent(q);
  searchOnSite: Driver["searchOnSite"] = (q) => this.protocol.searchOnSite(q);
}
