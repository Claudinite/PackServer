import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";

export { Quota, RootCoordinator, ScopeCoordinator } from "./objects";

export default {
  fetch: async (request, env, ctx) => createApp(await createRuntime(env)).fetch(request, undefined, ctx),
} satisfies ExportedHandler<Env>;
