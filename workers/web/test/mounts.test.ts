import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

// The §2.8 mounts feature tasks fill without touching index.ts: each is a stub module exporting a Hono router.
const MOUNTS = [
  ...["auth", "scopes", "orgs", "tokens", "packs", "private", "access", "trusted-publishers", "abuse", "well-known"].map((m) => `../src/routes/${m}/index.ts`),
  ...["api-leak", "publish-approval", "report-hash-mismatch"].map((m) => `../src/routes/${m}.ts`),
  ...["github", "session", "passkey", "recovery", "assert", "sessions", "recovery-review", "providers", "delete", "device"].map((m) => `../src/routes/auth/${m}.ts`),
  ...["view", "verify", "search", "contents", "stars", "reviews", "reports", "comments", "lifecycle"].map((m) => `../src/routes/packs/${m}.ts`),
  "../src/routes/well-known/audit-heads.ts",
  ...["home", "browse", "profile", "claude-code", "rules", "pricing", "pack", "signin", "account", "review", "report", "access", "dashboard", "validation", "publish", "org-settings", "github"].map((p) => `../src/pages/${p}/index.ts`),
];

describe("web mounts", () => {
  // The first import transforms the whole route module graph, which takes seconds; paying it here keeps each test to the export check.
  beforeAll(async () => {
    await Promise.all(MOUNTS.map((path) => import(/* @vite-ignore */ path)));
  }, 60_000);

  it.each(MOUNTS)("%s exports a router", async (path) => {
    const mod = (await import(/* @vite-ignore */ path)) as { routes?: unknown };
    expect(mod.routes).toBeInstanceOf(Hono);
  });
});
