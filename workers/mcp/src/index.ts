import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";
import { oauthWorker } from "./oauth/worker";

export default oauthWorker<Env>(
  {
    fetch: (request, env, ctx) => {
      const runtime = createRuntime(env);
      return createApp(runtime, { oauth: runtime.oauth }).fetch(request, undefined, ctx);
    },
  },
  createRuntime,
);
