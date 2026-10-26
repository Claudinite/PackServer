import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";
import { expectScanRan } from "./scan/scheduled";

/** The cron calls the scan route in-process, so a scheduled run records what a requested one does. */
const SCAN_REQUEST = "https://github.internal/internal/scan";

export default {
  fetch: (request, env, ctx) => createApp(createRuntime(env)).fetch(request, undefined, ctx),
  scheduled: async (_controller, env, ctx) => {
    const response = await createApp(createRuntime(env)).fetch(new Request(SCAN_REQUEST, { method: "POST" }), undefined, ctx);
    await expectScanRan(response);
  },
} satisfies ExportedHandler<Env>;
