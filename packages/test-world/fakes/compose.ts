import type { TestHarness } from "wrangler";
import { createFakePorts, type FakePorts } from "@packserver/ports/fakes";
import type { AScript } from "../fake-workers/sandbox/scripts";
import type { BScript } from "../fake-workers/sandbox/scripts";
import { FakeCdn } from "./cdn";
import { FakeDomains } from "./dns";
import { FakeGithubOidc } from "./github-oidc";
import { FakeGitHubLogin } from "./github-login";
import { FakeGithubApp } from "./github-app";
import { mailHandler } from "./mail";
import { Net } from "./net";
import { FakePushover } from "./pushover";
import { publishTestConfig } from "./publish-config";
import { FakeStagingS3, type StagingBucket } from "./staging-s3";
import { turnstileHandler } from "./turnstile";

export { EPOCH } from "../fake-workers/epoch";

/** Control ops that leave the fake in the same state when the server sees them twice. */
const REPEATABLE_OPS = new Set(["reset", "now", "set", "script", "calls"]);

/** A request on a pooled keep-alive socket the server had already closed, or that it reset. */
const isDroppedConnection = (error: unknown): boolean => {
  const code = ((error as { cause?: { code?: string } })?.cause?.code) ?? "";
  return error instanceof TypeError && (code === "UND_ERR_SOCKET" || code === "ECONNRESET");
};

/** The test process's handle on one fake Worker's control plane. */
export class FakeWorkerClient {
  /** Calls that were repeated once after the connection dropped; the retry succeeding shows the Worker itself stayed up. */
  static droppedConnectionRetries = 0;

  constructor(
    private readonly server: TestHarness,
    readonly name: string,
  ) {}

  private send(op: string, args: object | undefined): Promise<Response> {
    return this.server.getWorker(this.name).fetch(`http://${this.name}.fake/__control/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
  }

  async call<T = unknown>(op: string, args?: object): Promise<T> {
    let res: Response;
    try {
      res = await this.send(op, args);
    } catch (error) {
      if (!REPEATABLE_OPS.has(op) || !isDroppedConnection(error)) throw error;
      FakeWorkerClient.droppedConnectionRetries++;
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      console.warn(`[fake-worker-client] ${this.name}.${op}: connection dropped (${cause?.code}: ${cause?.message}); repeating once on a fresh socket`);
      res = await this.send(op, args);
      console.warn(`[fake-worker-client] ${this.name}.${op}: repeat answered ${res.status}, so the Worker stayed up`);
    }
    if (!res.ok) throw new Error(`${this.name} control ${op} answered ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { result: T }).result;
  }
}

export interface FakeWorkers {
  clock: FakeWorkerClient;
  ai: FakeWorkerClient;
  vectorize: FakeWorkerClient;
  sandboxA: FakeWorkerClient;
  sandboxB: FakeWorkerClient;
  access: FakeWorkerClient;
}

const WORKER_FOR: Record<keyof FakeWorkers, string> = {
  clock: "fake-clock",
  ai: "fake-ai",
  vectorize: "fake-vectorize",
  sandboxA: "fake-sandbox-a",
  sandboxB: "fake-sandbox-b",
  access: "fake-access",
};

/**
 * Everything faked for one file's worth of scenarios: the fake Workers behind the service
 * bindings, the HTTP fakes behind the interception point, and the in-memory port fakes the
 * area modules build on. `reset()` returns all of it to the starting point.
 */
export class WorldFakes {
  readonly net = new Net();
  readonly githubApp = new FakeGithubApp();
  readonly pushover = new FakePushover();
  readonly domains = new FakeDomains();
  readonly cdn = new FakeCdn();
  ports: FakePorts = createFakePorts();
  readonly githubLogin = new FakeGitHubLogin();
  readonly workers: Partial<FakeWorkers> = {};
  /** GitHub's token issuer and the staging bucket's S3 endpoint; present when the publish Worker is configured. */
  readonly oidc: FakeGithubOidc | undefined;
  readonly stagingS3: FakeStagingS3 | undefined;

  constructor(
    private readonly server: TestHarness,
    booted: readonly string[],
  ) {
    for (const [key, name] of Object.entries(WORKER_FOR)) {
      if (booted.includes(name)) this.workers[key as keyof FakeWorkers] = new FakeWorkerClient(server, name);
    }
    this.net.use((request) => turnstileHandler(this.ports.turnstile)(request));
    this.net.use((request) => mailHandler(this.ports.mail)(request));
    this.net.use((request) => this.pushover.handler()(request));
    const publish = publishTestConfig();
    if (publish) {
      const now = () => (this.workers.clock ? this.workers.clock.call<number>("now") : Promise.resolve(Date.now()));
      this.oidc = new FakeGithubOidc(publish.oidc, now);
      this.stagingS3 = new FakeStagingS3(publish.s3, now, async () => {
        const env = await server.getWorker<{ PACKS_STAGING: StagingBucket }>("publish-test").getEnv();
        return env.PACKS_STAGING;
      });
      this.net.use(this.oidc.handler);
      this.net.use(this.stagingS3.handler);
    }
    this.net.use(this.domains.handler);
    this.net.use(this.cdn.handler);
    this.net.use(this.githubLogin.handler);
    this.net.use(this.githubApp.handler());
    this.net.freeze();
  }

  get clock(): FakeWorkerClient {
    return this.workers.clock ?? this.missing("clock");
  }

  private missing(name: string): never {
    throw new Error(`the fake ${name} Worker is not booted`);
  }

  /** Makes container A misbehave for the upload with this sha256; anything unscripted runs for real. */
  async scriptSandboxA(sha256: string, script: AScript): Promise<void> {
    await (this.workers.sandboxA ?? this.missing("sandbox-a")).call("script", { sha256, script });
  }
  /** Makes container B answer as scripted for the canonical tree with this hash; anything unscripted loads cleanly. */
  async scriptSandboxB(treeHash: string, script: BScript): Promise<void> {
    await (this.workers.sandboxB ?? this.missing("sandbox-b")).call("script", { treeHash, script });
  }

  async reset(): Promise<void> {
    this.net.reset();
    this.stagingS3?.reset();
    await this.oidc?.reset();
    this.githubApp.reset();
    this.pushover.reset();
    this.domains.reset();
    this.cdn.reset();
    this.ports = createFakePorts();
    this.githubLogin.reset();
    await Promise.all(Object.values(this.workers).map((w) => w.call("reset")));
  }
}
