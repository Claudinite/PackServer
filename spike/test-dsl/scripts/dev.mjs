#!/usr/bin/env node
// Runs the system the way the http driver expects it: web on 8787, mcp on 8788,
// one shared local state dir (same D1), service binding resolved through wrangler's dev registry,
// and both outside dependencies pointed at the fakes server the http driver starts on 9797.
import { spawn } from "node:child_process";
const FAKES = `http://127.0.0.1:${process.env.FAKES_PORT ?? 9797}`;
const common = ["--persist-to", ".wrangler/state-dev", "--show-interactive-dev-session=false"];
const procs = [
  ["workers/mcp/wrangler.jsonc", "8788", []],
  ["workers/web/wrangler.jsonc", "8787", ["--var", `OIDC_ISSUER:${FAKES}/oidc`, "--var", `LLM_URL:${FAKES}/llm/validate`]],
].map(([cfg, port, extra]) =>
  spawn("npx", ["wrangler", "dev", "-c", cfg, "--port", port, ...common, ...extra], { stdio: "inherit" }),
);
const stop = () => procs.forEach((p) => p.kill("SIGINT"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
