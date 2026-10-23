import { logStubRun } from "@packserver/http";
import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";

export { SandboxA, SandboxB, ValidatePackWorkflow } from "./objects";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, env, ctx),
  scheduled: async (controller) => logStubRun("validator", controller.cron),
} satisfies ExportedHandler<Env>;
