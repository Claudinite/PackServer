import { appendFileSync } from "node:fs";
import { defaultCnUrl, installCn, runVendor } from "./cn.ts";
import { packDirectory } from "./pack.ts";
import { publish, verdictFailsJob } from "./run.ts";

const input = (name: string, fallback?: string): string => {
  const value = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`]?.trim() || fallback;
  if (!value) throw new Error(`input ${name} is required`);
  return value;
};

async function main(): Promise<void> {
  const dir = input("path", ".");
  const cnVersion = input("cn-version");
  let cn: string | undefined;
  const outcome = await publish(
    { pack: input("pack"), version: input("version"), registry: input("registry", "https://registry.claudinite.com") },
    {
      runner: process.env,
      fetch,
      async vendor() {
        cn = await installCn({ version: cnVersion, sha256: input("cn-sha256"), url: input("cn-url", defaultCnUrl(cnVersion)) }, fetch);
        await runVendor(cn, dir);
      },
      pack: () => packDirectory(dir),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
    },
  );
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `run-id=${outcome.runId}\nverdict=${outcome.verdict}\nsha256=${outcome.sha256}\n`);
  console.log(`verdict: ${outcome.verdict}${outcome.reason ? ` (${outcome.reason})` : ""}; the full report is in the dashboard`);
  if (verdictFailsJob(outcome.verdict)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
