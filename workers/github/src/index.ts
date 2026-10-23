import { logStubRun } from "@packserver/http";
import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, undefined, ctx),
  scheduled: async () => logStubRun("github", "weekly-scan"),
} satisfies ExportedHandler<Env>;
