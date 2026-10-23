import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";

export { Quota, RootCoordinator, ScopeCoordinator } from "./objects";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
