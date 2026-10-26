import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";

/** The cron calls the scan route in-process, so a scheduled run records what a requested one does. */
const SCAN_REQUEST = "https://github.internal/internal/scan";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, undefined, ctx),
  scheduled: async (_controller, env, ctx) => {
    const response = await createApp(createRuntime(env)).fetch(new Request(SCAN_REQUEST, { method: "POST" }), undefined, ctx);
    const body = (await response.json().catch(() => null)) as { outcome?: string } | null;
    // A run that could not reach GitHub, or ran out of allowance, fails loudly; it resumes on the next fire.
    if (!response.ok || body?.outcome === "unreachable" || body?.outcome === "rate_limited") {
      throw new Error(`the weekly scan ended ${body?.outcome ?? response.status}`);
    }
  },
} satisfies ExportedHandler<Env>;
