#!/usr/bin/env node
// Advances the version of the repo at `--root` and re-stamps its pages, in place,
// printing the new version and nothing else so a caller can capture it.
// `--stamp-only` re-stamps from the version already recorded and consumes no
// version number — the repair for a drift (a bad merge, a page added without the
// stamp) that `version-stamp-matches-package` reports.
//
// The scheme, the stamp and the set of files a bump rewrites are public/version.mjs;
// this file is only its working-tree caller. A release does not shell out to it: it
// builds a commit from the same function, on a branch tip, without a checkout.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bumpedFiles, VERSION_RECORD } from './public/version.mjs';

export function bump(root, { now = new Date(), stampOnly = false } = {}) {
  // git's own file list, so an untracked scratch page or a vendored copy under an
  // ignored directory is never stamped.
  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const read = (path) => { try { return readFileSync(join(root, path), 'utf8'); } catch { return null; } };
  const result = bumpedFiles({ read, tracked, now, stampOnly });
  if (!result) throw new Error(`${VERSION_RECORD} carries no version to ${stampOnly ? 'stamp from' : 'advance'}`);
  for (const [path, content] of Object.entries(result.files)) writeFileSync(join(root, path), content);
  return result.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Run from the repo it is bumping: the mount sits at .claudinite/shared/packs/<id>/,
  // so `--root` names the checkout when the cwd is not it.
  const flag = process.argv.indexOf('--root');
  const root = flag === -1 ? process.env.CLAUDE_PROJECT_DIR || process.cwd() : process.argv[flag + 1];
  console.log(bump(root, { stampOnly: process.argv.includes('--stamp-only') }));
}
