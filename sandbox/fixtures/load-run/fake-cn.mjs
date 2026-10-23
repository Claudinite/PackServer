#!/usr/bin/env node
// A stand-in for the cn engine: `cn check world` loads the packs vendored in the current
// repository and exits non-zero with a "file: message" line for the first problem.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const version = readFileSync(join(here, "VERSION"), "utf8").trim();
const cmp = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
};
if (process.argv[2] !== "check" || process.argv[3] !== "world") {
  console.error("usage: cn check world");
  process.exit(2);
}
// The state folder is whichever dot-folder holds the vendored packs.
const roots = readdirSync(".").filter((d) => d.startsWith(".") && existsSync(`${d}/shared/packs`)).map((d) => `${d}/shared/packs`);
for (const root of roots) {
  for (const scope of readdirSync(root)) {
    for (const name of readdirSync(join(root, scope))) {
      const dir = `${root}/${scope}/${name}`;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(`${dir}/pack.json`, "utf8"));
      } catch {
        console.error(`${dir}/pack.json: invalid JSON`);
        process.exit(1);
      }
      if (cmp(version, manifest.minEngineVersion ?? "0.0.0") < 0) {
        console.error(`${dir}/pack.json: minEngineVersion ${manifest.minEngineVersion} is newer than this engine ${version}`);
        process.exit(1);
      }
      if (manifest.usesFeature === "scoped-ids" && cmp(version, "1.61004.1") < 0) {
        console.error(`${dir}/pack.json: scoped ids need engine 1.61004.1, this is ${version}`);
        process.exit(1);
      }
    }
  }
}
console.log(`cn ${version}: world ok`);
