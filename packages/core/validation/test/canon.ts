import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("./fixtures/canon/", import.meta.url).pathname;

function walk(dir: string, prefix: string, out: Record<string, string>) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`, out);
    else out[`${prefix}${name.replace(/\.fixture$/, "")}`] = readFileSync(full, "utf8");
  }
}

/** Real files of a canon pack (stored with a .fixture suffix so no tool mistakes them for a declaration), keyed by archive path. */
export function canonPack(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  walk(join(ROOT, name), "", out);
  return out;
}

export const CANON_PACKS = readdirSync(ROOT).sort();
