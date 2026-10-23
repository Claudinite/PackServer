import table from "../trust-table.json" with { type: "json" };

export const TRUST_TABLE = table.workers;
export type WorkerName = keyof typeof TRUST_TABLE;
export const WORKER_NAMES = Object.keys(TRUST_TABLE) as WorkerName[];

export type R2Access = "read" | "write" | "read-write";

type BindingKind = "kv" | "r2" | "queues" | "workflows";

/** Binding names of one kind, for one Worker or (with no Worker) every Worker. */
export function bindingNames(kind: BindingKind, worker?: WorkerName): string[] {
  const workers = worker ? [worker] : WORKER_NAMES;
  return [...new Set(workers.flatMap((w) => Object.keys(TRUST_TABLE[w][kind])))];
}

export function rateLimitNames(worker?: WorkerName): string[] {
  const workers = worker ? [worker] : WORKER_NAMES;
  return [...new Set(workers.flatMap((w) => TRUST_TABLE[w].ratelimits))];
}

/** Every binding name the trust table gives a Worker, whichever product it is. */
export function expectedBindings(worker: WorkerName): string[] {
  const t = TRUST_TABLE[worker];
  return [
    ...Object.keys(t.d1), ...Object.keys(t.kv), ...Object.keys(t.r2), ...Object.keys(t.queues), ...Object.keys(t.workflows),
    ...Object.keys(t.durable_objects), ...Object.keys(t.containers), ...Object.keys(t.services), ...Object.keys(t.vectorize),
    ...t.ai, ...Object.keys(t.analytics), ...t.ratelimits, ...t.secrets, "CF_VERSION_METADATA",
  ];
}

export function missingBindings(worker: WorkerName, env: object): string[] {
  return expectedBindings(worker).filter((name) => (env as Record<string, unknown>)[name] === undefined);
}
