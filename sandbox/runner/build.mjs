// Bundles the runner and its worker into the two files the image runs. The workspace packages
// import without file extensions, which Node cannot resolve unbundled.
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

export function buildRunner(outdir) {
  return build({
    entryPoints: ["a-main.ts", "a-worker.ts", "a-corpus.ts"],
    absWorkingDir: import.meta.dirname,
    outdir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    logLevel: "warning",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildRunner(process.argv[2] ?? "dist");
