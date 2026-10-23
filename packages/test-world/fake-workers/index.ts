import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface FakeWorkerSpec {
  /** The service name production-shaped `env.test` blocks bind to. */
  name: string;
  main: string;
  /** Durable Object classes the fake hosts, declared with a SQLite-free migration. */
  durableObjects?: Record<string, string>;
}

/** Every fake Worker the test world provides; a name the trust table asks for that is missing here fails the boot. */
export const FAKE_WORKERS: Record<string, FakeWorkerSpec> = {
  "fake-clock": { name: "fake-clock", main: join(HERE, "clock/index.ts"), durableObjects: { CLOCK_STATE: "ClockState" } },
  "fake-ai": { name: "fake-ai", main: join(HERE, "ai/index.ts") },
  "fake-vectorize": { name: "fake-vectorize", main: join(HERE, "vectorize/index.ts") },
  "fake-sandbox-a": { name: "fake-sandbox-a", main: join(HERE, "sandbox/a.ts") },
  "fake-sandbox-b": { name: "fake-sandbox-b", main: join(HERE, "sandbox/b.ts") },
  "fake-access": { name: "fake-access", main: join(HERE, "access/index.ts") },
};

export const CLOCK_WORKER = "fake-clock";

/** The inline Wrangler config the harness boots a fake from. */
export function fakeWorkerConfig(spec: FakeWorkerSpec) {
  return {
    name: spec.name,
    main: spec.main,
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    ...(spec.durableObjects
      ? {
          durable_objects: { bindings: Object.entries(spec.durableObjects).map(([name, class_name]) => ({ name, class_name })) },
          migrations: [{ tag: "v1", new_sqlite_classes: Object.values(spec.durableObjects) }],
        }
      : {}),
  };
}
