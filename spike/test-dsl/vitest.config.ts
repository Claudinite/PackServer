import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Requirement IDs become strict vitest tags: a scenario naming an unknown REQ fails at collection.
const register = readFileSync(new URL("./requirements.md", import.meta.url), "utf8");
const requirements = [...register.matchAll(/^## (REQ-[A-Z]+-\d{3}) (.+)$/gm)].map((m) => ({ name: `req/${m[1]}`, description: m[2] })); // any status: retired ones still tag old scenarios

const httpDriver = process.env.TEST_DRIVER === "http";

export default defineConfig({
  test: {
    // The tooling tests exercise the in-process driver itself, so they only run in that mode.
    include: httpDriver ? ["tests/scenarios/**/*.scenario.ts"] : ["tests/scenarios/**/*.scenario.ts", "tests/tooling/**/*.test.ts"],
    // The http driver's fakes listen on one fixed port the system was pointed at, so files run one at a time.
    fileParallelism: !httpDriver,
    tags: requirements,
    strictTags: true,
    testTimeout: 30_000,
    hookTimeout: 90_000,
    // One harness per test file; files run in parallel worker processes by default.
    pool: "forks",
  },
});
