# Public website

- **Writing a version number into a page** — don't: `title="version …"` is generated from
  `package.json` by the pack's bump, and a hand-typed stamp names a build that was never served.
  Repair a drifted one, consuming no version number, with (writing-version-number)

  ```
  node .claudinite/shared/packs/public-website/bump-version.mjs --stamp-only
  ```

- **Deciding how long a published asset may be cached** — publish a manifest naming every asset
  and a hash of its contents, fetch that on each load and evict the entries whose hash moved,
  rather than giving each file a TTL guessed from how fast you think it changes.
  (deciding-long-published)

- **Caching a freshness manifest, or judging an asset stale by its size** — neither works: nothing
  can attest to its own freshness, so the expected hash must come from a file fetched fresher than
  the one it judges, and a uniform correction is routinely byte-length-neutral.
  (caching-freshness-manifest)

- **Splitting a payload so each half caches on its own schedule** — have each half record the
  other's generation and refetch both on a mismatch, because every visitor eventually holds one
  half from Tuesday and the other from Thursday; then assert on the join *rate*, since a partial
  join is silent. (splitting-payload-each)

- **Judging a failed fetch survivable because the value "just shows as unknown"** — trace it to
  what it draws first. An absent value reaching a boolean, a comparison or a status lookup is
  usually indistinguishable from a real negative, so the page renders a confident falsehood with
  nothing logged. Where it isn't survivable, fail the load and show the error state.
  (judging-failed-fetch)
