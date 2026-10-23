import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";

export { Quota, RootCoordinator, ScopeCoordinator } from "./objects";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, undefined, ctx),
} satisfies ExportedHandler<Env>;
