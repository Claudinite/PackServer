import { expectedBindings, TRUST_TABLE, type WorkerName } from "@packserver/ports";
import { expect, it, describe } from "vitest";
import { VERSION_HEADER } from "./version";

type Fetchable = { fetch(request: Request): Response | Promise<Response> };

export interface ShellHarnessOptions {
  /** Whether the self-test is open to the request; false is the production default. */
  allowSelfTest: boolean;
  missingBindings?: string[];
}

export interface WorkerShellContract {
  worker: string;
  build: (options: ShellHarnessOptions) => Fetchable;
}

const RELEASE = "rel-test";
const SELFTEST_PATHS = (worker: string) => ["/__selftest", `/${worker}/__selftest`];

async function snapshot(res: Response) {
  const headers = Object.fromEntries([...res.headers].filter(([k]) => k !== "date"));
  return { status: res.status, headers, body: await res.text() };
}

/** The skeleton halves of IT-OPS-004, IT-OPS-006 and IT-OPS-010, the same for every Worker. */
export function describeWorkerShell({ worker, build }: WorkerShellContract): void {
  describe(`${worker}: the shell every Worker starts from`, () => {
    it("IT-OPS-006 names the answering release on an unknown path", async () => {
      const res = await build({ allowSelfTest: false }).fetch(new Request("https://registry.test/no/such/path"));
      expect(res.status).toBe(404);
      expect(res.headers.get(VERSION_HEADER)).toBe(RELEASE);
    });

    it.each(SELFTEST_PATHS(worker))("IT-OPS-004 answers an anonymous %s exactly as an unknown path", async (path) => {
      const app = build({ allowSelfTest: false });
      const unknown = await snapshot(await app.fetch(new Request("https://registry.test/no/such/path")));
      const selfTest = await snapshot(await app.fetch(new Request(`https://registry.test${path}`)));
      expect(selfTest).toEqual(unknown);
    });

    it.each(SELFTEST_PATHS(worker))("answers an allowed caller at %s in the fixed shape", async (path) => {
      const res = await build({ allowSelfTest: true }).fetch(new Request(`https://registry.test${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get(VERSION_HEADER)).toBe(RELEASE);
      const body = (await res.json()) as { version_id: string; release_id: string; ok: boolean; checks: Array<{ name: string; ok: boolean; ms: number; detail: string }> };
      expect(Object.keys(body).sort()).toEqual(["checks", "ok", "release_id", "version_id"]);
      expect(body).toMatchObject({ version_id: "version-test", release_id: RELEASE, ok: true });
      for (const c of body.checks) expect(Object.keys(c).sort()).toEqual(["detail", "name", "ok", "ms"].sort());
    });

    it("IT-OPS-010 shallow mode runs the local checks and none that call out", async () => {
      const res = await build({ allowSelfTest: true }).fetch(new Request("https://registry.test/__selftest?shallow=1"));
      const body = (await res.json()) as { checks: Array<{ name: string }> };
      const names = body.checks.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(["config.environment", "bindings.present", "secrets.present"]));
      expect(names.filter((n) => n.startsWith("outbound.") || n.startsWith("service."))).toEqual([]);
    });

    it("fails the self-test when a binding is missing", async () => {
      const res = await build({ allowSelfTest: true, missingBindings: ["DB"] }).fetch(new Request("https://registry.test/__selftest"));
      const body = (await res.json()) as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
      expect(body.ok).toBe(false);
      expect(body.checks.find((c) => c.name === "bindings.present")).toMatchObject({ ok: false, detail: "failed" });
    });
  });
}

export const SHELL_RELEASE = RELEASE;
export const SHELL_VERSION = "version-test";

/** An `env` with every binding the trust table gives the Worker, as an empty object that is never called; under `env.test` a fake Worker's binding is a service binding. */
export function dummyEnv(worker: WorkerName, environment = "test"): Record<string, unknown> {
  const fakes = environment === "test" ? Object.keys(TRUST_TABLE[worker].fakes) : [];
  const env: Record<string, unknown> = Object.fromEntries(expectedBindings(worker).map((name) => [name, fakes.includes(name) ? { fetch: () => {} } : {}]));
  env.WORKER = worker;
  env.ENVIRONMENT = environment;
  env.CF_VERSION_METADATA = { id: "version-9", tag: "rel-9" };
  return env;
}

/** The port records carry exactly the binding names the trust table gives, and a read-only bucket has no write method. */
export function expectPortsMatchTrustTable(
  worker: WorkerName,
  wired: object,
): void {
  const t = TRUST_TABLE[worker];
  const ports = wired as { kv?: object; r2?: Record<string, object>; queues?: object; workflows?: object; rateLimits?: object };
  expect(Object.keys(ports.kv ?? {}).sort()).toEqual(Object.keys(t.kv).sort());
  expect(Object.keys(ports.r2 ?? {}).sort()).toEqual(Object.keys(t.r2).sort());
  expect(Object.keys(ports.queues ?? {}).sort()).toEqual(Object.keys(t.queues).sort());
  expect(Object.keys(ports.workflows ?? {}).sort()).toEqual(Object.keys(t.workflows).sort());
  expect(Object.keys(ports.rateLimits ?? {}).sort()).toEqual([...t.ratelimits].sort());
  for (const [name, bucket] of Object.entries(t.r2)) {
    const port = ports.r2?.[name] as Record<string, unknown>;
    const writable = bucket.access !== "read";
    expect(typeof port.put === "function", `${name} write methods`).toBe(writable);
    expect(typeof port.delete === "function", `${name} delete method`).toBe(writable);
  }
}
