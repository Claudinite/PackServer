import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";
import { runScheduled } from "./gates/scheduled";
import { signalEmitter } from "./heartbeat/emit";
import { scheduledAlerts } from "./router/compose";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, undefined, ctx),
  scheduled: async (_controller, env) => {
    const runtime = createRuntime(env);
    const { ports, config } = runtime;
    const gatesKv = ports.kv["GATES_KV"];
    const telemetryKv = ports.kv["TELEMETRY_KV"];
    if (!gatesKv || !telemetryKv) throw new Error("the judge's KV namespaces are not bound");
    const emit = signalEmitter({ releaseId: runtime.version.releaseId, versionId: runtime.version.versionId, clock: ports.clock, stats: ports.stats, telemetry: ports.telemetry });
    await runScheduled({
      clock: ports.clock,
      gatesKv,
      telemetryKv,
      data: config.data,
      stats: ports.stats,
      admin: config.adminClient,
      audit: config.audit,
      emit,
      ...scheduledAlerts(runtime, emit),
      ciTokenIds: config.ciTokenIds,
      dailyLogAllowance: config.dailyLogAllowance,
    });
  },
} satisfies ExportedHandler<Env>;
