// THE PUBLIC SEAM of the public-website pack: the version a public website carries,
// and the copy of it its pages show. A hosting pack's release reaches in here to
// advance the version as part of cutting a release — through this file and nothing
// else in the pack — and a release that finds the file absent (the pack undeclared,
// so not on the mount) goes out without a bump.
//
// Scheme: `<major>.<ymmdd>.<build>`
//   - major  is carried over from the version already recorded — a generation
//            statement, raised by hand and never by a release
//   - ymmdd  is the release date: years since EPOCH_YEAR, then zero-padded UTC
//            month and day. 2026-09-17 is 10917; 2027-01-01 is 20101.
//   - build  is a monotonic counter: previous build + 1, so it advances even when
//            the day (and therefore the middle part) rolls over
//
// THE YEAR OFFSET is what makes the middle part mean "later". A bare MMDD runs
// backwards every New Year — 1231 is followed by 0101 — so the one thing every
// reader of a version assumes stopped being true once a year, and the ordering
// rested entirely on the build counter. Counting years from a fixed epoch makes
// it strictly increasing with no wrap to absorb: the offset simply grows, taking
// the part to six digits in 2035, which is still numerically above 2034's five.
//
// `package.json` is the single source of truth. A page says where its copy goes by
// carrying `title="version …"` on whatever element should show it (a footer
// copyright, a build line); that attribute is GENERATED from the record, and the
// `version-stamp-matches-package` check fails a tree where the two disagree. Every
// tracked page is a candidate: the stamp is the page's own opt-in, so nothing here
// has to know which directory is served or by whom.

export const VERSION_RECORD = 'package.json';

// The stamp as authored: `title="version 1.10913.7"`, anywhere on a page. Exported so
// the generator and the drift check spell it one way.
export const STAMP = /title="version [^"]*"/g;

// Year zero of the scheme: 2026 is the offset's 1, so the middle part never carries
// a leading zero and never repeats. Moving it would renumber every release ever cut,
// so it is a constant rather than a setting.
export const EPOCH_YEAR = 2025;

export const isPage = (path) => path.endsWith('.html');

// The date half of the version, for `now`: `<years since EPOCH_YEAR><MM><DD>`, all
// read in UTC because a runner's local zone is not the repo's and a version must not
// depend on which region the job landed in.
export function releaseDate(now = new Date()) {
  return `${now.getUTCFullYear() - EPOCH_YEAR}${now.toISOString().slice(5, 10).replace('-', '')}`;
}

// The version that follows `current`, released at `now`. An unparseable build
// (the initial "1.0.0", a hand-typed string) counts as 0, so the first bump lands
// on 1 rather than NaN.
export function nextVersion(current, now = new Date()) {
  const [major, , build] = String(current ?? '').split('.');
  const prevBuild = Number.parseInt(build, 10);
  return `${/^\d+$/.test(major ?? '') ? major : '1'}.${releaseDate(now)}.${(Number.isFinite(prevBuild) ? prevBuild : 0) + 1}`;
}

// One page's stamp. A page carrying no `title="version …"` is returned unchanged —
// it has not asked for the version, and nothing is inserted into markup here.
export function stampHtml(html, version) {
  return html.replace(STAMP, `title="version ${version}"`);
}

// The bump as file contents — `{ version, files: { path: content } }` — pure over
// `read`, so a release building a commit from a branch tip and the CLI writing a
// working tree share one definition. `stampOnly` re-stamps from the version already
// recorded and rewrites no record. Returns null when the tree carries no version to
// work from; whether that parks a release or is a plain "nothing to bump" is the
// caller's to say.
export function bumpedFiles({ read, tracked, now = new Date(), stampOnly = false }) {
  const recordText = read(VERSION_RECORD);
  if (recordText == null) return null;
  const record = JSON.parse(recordText);
  const version = stampOnly ? record.version : nextVersion(record.version, now);
  if (!version) return null;
  const files = {};
  if (!stampOnly) files[VERSION_RECORD] = `${JSON.stringify({ ...record, version }, null, 2)}\n`;
  for (const page of tracked.filter(isPage)) {
    const html = read(page);
    if (html == null) continue;
    const stamped = stampHtml(html, version);
    if (stamped !== html) files[page] = stamped;
  }
  return { version, files };
}
