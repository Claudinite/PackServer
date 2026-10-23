import type { TestHarness } from "wrangler";
import { createFakePorts, type FakePorts } from "@packserver/ports/fakes";
import type { SandboxAReport, SandboxBReport } from "@packserver/ports";
import { Net } from "./net";
import { turnstileHandler } from "./turnstile";

export { EPOCH } from "../fake-workers/epoch";

/** The test process's handle on one fake Worker's control plane. */
export class FakeWorkerClient {
  constructor(
    private readonly server: TestHarness,
    readonly name: string,
  ) {}

  async call<T = unknown>(op: string, args?: object): Promise<T> {
    const res = await this.server.getWorker(this.name).fetch(`http://${this.name}.fake/__control/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
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
  ports: FakePorts = createFakePorts();
  readonly workers: Partial<FakeWorkers> = {};

  constructor(
    private readonly server: TestHarness,
    booted: readonly string[],
  ) {
    for (const [key, name] of Object.entries(WORKER_FOR)) {
      if (booted.includes(name)) this.workers[key as keyof FakeWorkers] = new FakeWorkerClient(server, name);
    }
    this.net.use((request) => turnstileHandler(this.ports.turnstile)(request));
    this.net.freeze();
  }

  get clock(): FakeWorkerClient {
    return this.workers.clock ?? this.missing("clock");
  }

  private missing(name: string): never {
    throw new Error(`the fake ${name} Worker is not booted`);
  }

  async scriptSandboxA(key: string, report: SandboxAReport): Promise<void> {
    await (this.workers.sandboxA ?? this.missing("sandbox-a")).call("scriptInspect", { key, report });
  }
  async scriptSandboxB(key: string, report: SandboxBReport): Promise<void> {
    await (this.workers.sandboxB ?? this.missing("sandbox-b")).call("scriptRun", { key, report });
  }

  async reset(): Promise<void> {
    this.net.reset();
    this.ports = createFakePorts();
    await Promise.all(Object.values(this.workers).map((w) => w.call("reset")));
  }
}
