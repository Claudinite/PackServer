import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";
import { runCycle } from "./cycle";
import { signalEmitter } from "./emit";

// A bare reference to the global would be called with the wrong receiver once stored on an object.
const outbound: typeof fetch = (input, init) => fetch(input, init);

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, undefined, ctx),
  scheduled: async (_controller, env) => {
    const runtime = createRuntime(env);
    const kv = runtime.ports.kv["TELEMETRY_KV"];
    if (!kv) throw new Error("the prober's KV namespace is not bound");
    const config = runtime.config();
    const [access, selfTestKey] = await Promise.all([config.accessToken(), config.selfTestKey()]);
    await runCycle({
      config,
      credentials: { access, selfTestKey },
      clock: runtime.ports.clock,
      kv,
      fetch: outbound,
      emit: signalEmitter({ releaseId: runtime.version.releaseId, versionId: runtime.version.versionId, clock: runtime.ports.clock, stats: runtime.ports.stats, telemetry: runtime.ports.telemetry }),
    });
  },
} satisfies ExportedHandler<Env>;
