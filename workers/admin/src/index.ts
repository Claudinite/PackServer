import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";
import { consumeAudit } from "./consumers/audit";
import { runCron } from "./crons";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, undefined, ctx),
  scheduled: (controller, env) => runCron(controller.cron, createRuntime(env)),
  queue: (batch, env) => consumeAudit(batch, createRuntime(env)),
} satisfies ExportedHandler<Env>;
