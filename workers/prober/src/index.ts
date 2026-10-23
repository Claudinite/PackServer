import { logStubRun } from "@packserver/http";
import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, env, ctx),
  scheduled: async () => logStubRun("prober", "probe-safe"),
} satisfies ExportedHandler<Env>;
