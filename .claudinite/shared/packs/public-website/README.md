# public-website pack

Being a public website, whatever serves it: the version the site carries and the stamp its pages show, and the ways a page that fetches its own data goes quietly stale. **Opt-in**: a project declares it when it publishes a site, beside the pack for whatever hosts the site. Nothing here builds, serves or releases anything, and nothing here names a host: a hosting pack's release reaches [`public/version.mjs`](public/version.mjs) to advance the version as part of cutting a release, and goes out without a bump when the file is absent.

## The version

`<major>.<ymmdd>.<build>`, computed and never typed: the major is a generation statement raised by hand, the middle part is the UTC release date counted in years from 2025, and the build is a monotonic counter. `package.json` is the one record; a page opts into showing the version by carrying `title="version …"` on the element that should show it, and the bump stamps every tracked page that does. The scheme, the stamp and the set of files a bump rewrites live in [`public/version.mjs`](public/version.mjs); [`bump-version.mjs`](bump-version.mjs) is its working-tree caller, with `--stamp-only` as the drift repair.

## Checks

| Check | Severity | Reason | Enforcement |
|---|---|---|---|
| `public-website/version-stamp-matches-package` | medium | correctness | check: blocking |

What it holds: every tracked page carrying a stamp names `package.json`'s version.

## Rules (`RULES.md`)

| Rule | Severity | Reason | Enforcement |
|---|---|---|---|
| The version stamp is generated, never typed | medium | correctness | prose: <50 words + check (`public-website/version-stamp-matches-package`) |
| Freshness is a published manifest's job | high | correctness | prose: <100 words |
| Nothing attests to its own freshness | high | correctness | prose: <50 words |
| Split caches join across generations | critical | correctness | prose: <100 words |
| Follow missing data to the pixel | high | correctness | prose: <100 words |

The last four are the client-side half: the four ways a page that fetches its own data goes stale quietly.
