#!/usr/bin/env node
// Stages the witness (infra/witness) for Claudinite/packserver-witness. Nothing here talks to
// GitHub: the tool copies the files into a directory you then commit and push to that repository,
// and prints what a person has to set there.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const SOURCE = join(import.meta.dirname, "..", "infra", "witness");
export const TARGET_REPO = "Claudinite/packserver-witness";

/** Actions secrets the workflows read; each says where the value comes from. */
export const SECRETS = [
  ["GH_PAT", "Upptime pushes its history to main: a fine-grained token on this repository, Contents and Issues read/write, Workflows read/write"],
  ["WITNESS_HOOK_SECRET", "the value of the judge's Secrets Store entry hook-secret-witness (staging: hook-secret-witness-staging); signs every report"],
  ["CF_ACCOUNT_ID", "the Cloudflare account id"],
  ["CF_ANALYTICS_READ_TOKEN", "a new token with only Account | Account Analytics | Read, used to read the judge heartbeat"],
  ["PUSHOVER_APP_TOKEN", "the Pushover application token the judge pages with"],
  ["PUSHOVER_USER_KEY", "Ariel's Pushover user key"],
];

export const HUMAN_STEPS = [
  `Create ${TARGET_REPO} (private) if infra/github-org.mjs has not; commit the staged files to its main.`,
  `Set the Actions secrets above on ${TARGET_REPO}.`,
  `Exempt ${TARGET_REPO} from the main-protection ruleset or add the Upptime token's owner as a bypass actor: Upptime commits straight to main.`,
  "Enable GitHub Pages from the gh-pages branch (Settings, Pages); a private repository needs a plan that supports Pages for private repositories.",
  "Run the Setup CI workflow once, then Uptime CI; confirm the three sites are up and the Witness report run is green.",
  "Fire drill from monitoring.md: point one site at a failing host and confirm a page arrives after the second failed probe.",
];

/** Every file the witness repository carries, relative to its root; tests stay behind. */
export function managedFiles(source = SOURCE) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!name.endsWith(".test.mjs")) out.push(relative(source, path));
    }
  };
  walk(source);
  return out;
}

export function stage(target, source = SOURCE) {
  const files = managedFiles(source);
  for (const file of files) {
    const to = join(target, file);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(join(source, file), to);
  }
  return files;
}

/** Files of the directory that differ from the source, or are missing. */
export function drift(target, source = SOURCE) {
  return managedFiles(source).filter((file) => {
    const path = join(target, file);
    return !existsSync(path) || !readFileSync(path).equals(readFileSync(join(source, file)));
  });
}

const USAGE = `Usage: node tools/witness-apply.mjs [--stage <dir> | --check <dir>]

Prepares ${TARGET_REPO}. It never contacts GitHub.

  (no flags)       list the files and what a person must set up
  --stage <dir>    copy the files into <dir> (created if missing)
  --check <dir>    exit 1 when <dir> differs from the files here
  --help           this text
`;

export function main(argv, out = console.log) {
  const { values } = parseArgs({ args: argv, options: { stage: { type: "string" }, check: { type: "string" }, help: { type: "boolean" } }, strict: true });
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (values.stage && values.check) throw new Error("--stage and --check are exclusive");
  if (values.check) {
    const changed = drift(resolve(values.check));
    for (const file of changed) out(`differs: ${file}`);
    out(changed.length === 0 ? "in sync" : `${changed.length} file(s) out of sync`);
    return changed.length === 0 ? 0 : 1;
  }
  const files = values.stage ? stage(resolve(values.stage)) : managedFiles();
  out(`${values.stage ? "Staged" : "Would stage"} for ${TARGET_REPO}:`);
  for (const file of files) out(`  ${file}`);
  out("\nActions secrets:");
  for (const [name, source] of SECRETS) out(`  ${name}: ${source}`);
  out("\nA person must:");
  HUMAN_STEPS.forEach((step, i) => out(`  ${i + 1}. ${step}`));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
