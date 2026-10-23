import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
