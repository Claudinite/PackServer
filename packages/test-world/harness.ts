import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestHarness, type TestHarness } from "wrangler";
import testFakes from "@packserver/ports/test-fakes" with { type: "json" };
import { TRUST_TABLE, type WorkerName } from "@packserver/ports";
import { REPO_ROOT } from "./root";
import { CLOCK_WORKER, FAKE_WORKERS, fakeWorkerConfig } from "./fake-workers";

export { REPO_ROOT } from "./root";

/** The name a product Worker runs under in the harness: its `env.test` block names it `<worker>-test`. */
export const testWorkerName = (worker: string): string => `${worker}-test`;

/** The Worker that answers a request no route claims; the rest are reached by name. */
const PRIMARY: WorkerName = "web";

export interface HarnessOptions {
  root?: string;
  /** Overrides the discovered set, for a test of the harness itself. */
  workers?: string[];
  /** Test-only vars per Worker, laid over its `env.test` block. */
  vars?: Record<string, Record<string, string>>;
}

export interface WorldHarness {
  server: TestHarness;
  root: string;
  workers: WorkerName[];
  fakes: string[];
}

/** Every `workers/<name>` that has a Wrangler config, primary first. */
export function discoverWorkers(root: string): WorkerName[] {
  const dir = join(root, "workers");
  const found = readdirSync(dir).filter((name) => existsSync(join(dir, name, "wrangler.jsonc")));
  const unknown = found.filter((name) => !(name in TRUST_TABLE));
  if (unknown.length > 0) throw new Error(`workers/${unknown[0]} has no entry in the trust table`);
  return (found as WorkerName[]).sort((a, b) => Number(b === PRIMARY) - Number(a === PRIMARY) || a.localeCompare(b));
}

/** The fake Workers a set of product Workers binds under `env.test`, from the test-only fakes file. */
export function fakesFor(workers: WorkerName[]): string[] {
  const names = new Set<string>([CLOCK_WORKER]);
  for (const worker of workers) for (const fake of Object.values((testFakes as Record<string, Record<string, string>>)[worker] ?? {})) names.add(fake);
  const missing = [...names].filter((n) => !(n in FAKE_WORKERS));
  if (missing.length > 0) throw new Error(`the trust table binds ${missing.join(", ")} but the test world has no such fake Worker`);
  return [...names].sort();
}

/** Boots whichever `workers/*` exist, each under its `env.test`, with the fake Workers they bind and the fake clock attached to all. */
export function createWorldHarness(options: HarnessOptions = {}): WorldHarness {
  const root = options.root ?? REPO_ROOT;
  const workers = (options.workers ?? discoverWorkers(root)) as WorkerName[];
  const fakes = fakesFor(workers);
  const server = createTestHarness({
    root,
    workers: [
      ...workers.map((w) => ({
        configPath: `workers/${w}/wrangler.jsonc`,
        env: "test",
        bindingOverrides: { CLOCK: CLOCK_WORKER },
        ...(options.vars?.[w] ? { vars: options.vars[w] } : {}),
      })),
      ...fakes.map((name) => ({ config: fakeWorkerConfig(FAKE_WORKERS[name]!) as never })),
    ],
  });
  return { server, root, workers, fakes };
}
