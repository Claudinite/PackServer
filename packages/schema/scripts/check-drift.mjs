// Fails when the Drizzle schema has changes no migration carries: generating into a copy must write nothing.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
// drizzle-kit prefixes the out path with "./", so the copy must be relative; .wrangler is gitignored.
const relative = `.wrangler/drift-${process.pid}`;
const scratch = join(root, relative);
mkdirSync(scratch, { recursive: true });
try {
  cpSync(join(root, "migrations"), scratch, { recursive: true });
  const sql = () => readdirSync(scratch).filter((f) => f.endsWith(".sql"));
  const before = sql().length;
  execFileSync("pnpm", ["exec", "drizzle-kit", "generate", "--name", "drift"], {
    cwd: root,
    env: { ...process.env, DRIZZLE_OUT: relative },
    stdio: "pipe",
  });
  if (sql().length !== before) {
    console.error("the Drizzle schema has changes no migration carries; run pnpm --filter @packserver/schema db:generate");
    process.exitCode = 1;
  } else {
    console.log("check-drift: schema and migrations agree");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
