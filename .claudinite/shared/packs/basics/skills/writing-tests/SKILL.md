---
name: writing-tests
description: Practices for writing tests you can trust. Use before writing or changing any test — see-it-fail discipline, snapshot/golden rules, CI-only and heavy-browser tests, fuzzy-metric gating.
metadata:
  body: guidelines
  usage:
    expect: triggered
  force-load-on-file-edits-paths:
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/*_test.*"
    - "**/test_*.*"
    - "**/test/**"
    - "**/tests/**"
    - "**/__tests__/**"
    - "**/spec/**"
---

# Testing practices

A consuming repo's own test *mechanics* — runner, layout, which suites exist — are its own docs'; CI-trigger rules and the `GITHUB_TOKEN` workflow-recursion gotcha are [git-github-advanced](../../../git-github/skills/git-github-advanced/SKILL.md)'s.

- See a test fail before you trust it: write it red before the fix (green after), or break what it guards and watch it go red. A test that has never failed proves nothing. For a **refusal/negative** test — one asserting a guard yields *nothing* — the write-it-red-first branch is unavailable: the pre-change code also yielded nothing, so the test passes from birth and proves nothing. See-it-fail there **must** be the second method — mutate the new guard (weaken it), watch the test bite, then restore it. Restore with `git checkout -- <file>` (or `git stash`) taken at the moment of mutating — never a `.bak` copy saved earlier, which predates whatever else you edited in between and silently discards that intervening work. If the mutation was **staged** (to make a check that scans `git diff --cached` fire), a bare `git checkout -- <file>` restores from the index — which now holds the mutation — so the "restore" is a no-op; use `git checkout HEAD -- <file>` (or `git reset` first).
  (see-test-fail)
- A mechanism meant to survive a retry, re-queue, or hand-off needs a test that calls it twice, not once. A suite of single-call tests stays green while the multi-call case corrupts state — the double-call is what a real retry, requeue, or hand-off actually does. When the mechanism arbitrates by identity (a claim, a lock), the second call must come from a **different actor**: a single actor retrying its own stale claim can't expose an identity-masked race, since it still recognizes its own claim as valid.
  (mechanism-meant-survive)
- A simulator of a stateful mechanism must advance state only where the real engine's code actually leaves a mark — never wherever the rule's stated description says a transition happens. A sim that fires on every event matching the rule's *intent* is correct by construction against that rule and blind to exactly the silent paths where the real implementation and the rule have quietly diverged — which is where a genuine bug usually lives. Read the real engine's code for what it *writes*, and model that.
  (simulator-stateful-mechanism)
- Before trusting a new transform/normalizer, run it over the *real existing corpus* it will process, not just hand-picked test inputs — the live data exposes edge cases your examples won't. Relatedly, prefer a generic structural rule over a hand-maintained list of special cases: the enumerated list needs per-instance upkeep and silently has gaps, while a rule keyed on structure (e.g. "a known registry label under any 2-letter ccTLD") covers the whole class at once.
  (trusting-new-transform)
- A test that stubs the exact boundary where the bug lives can't catch that bug — it guards only the shape it asserts, not the runtime effect. Say what it can't catch.
  (test-stubs-exact)
- A test that dereferences a path inside a **read-only dependency tree someone else refreshes** — a vendored mount, a synced submodule, generated output from an upstream build — is a test whose fixture a stranger can delete: the day upstream retires that file the case fails `ENOENT` with nothing in your repo having changed. Assert against a path only when the test itself creates it; when a case genuinely needs an upstream file, read it **defensively** and skip with a stated reason if it is gone, so a retirement upstream reports as "no longer applicable" rather than as your repo being broken. Check what actually runs these cases too — a suite that the repo's own gate never invokes reports its breakage to whoever happens to look.
  (test-dereferences-path)
- **Never test that a value is set.** A test that reads a value someone declared — a config or manifest field (`assert.equal(task.expected_outcome, 'fresh_pr')`), an exported constant or default object (`assert.deepEqual(DEFAULTS, {…})`), a settings file naming a pack, a workflow's `run:` line, a frontmatter key — and asserts it is the literal it was set to restates the file under test in a second file. It can only fail when someone changes the value **on purpose**, so it catches no defect and instead taxes every deliberate change with a mirrored edit — and teaches that the value is load-bearing prose to be restated, which is how one setting ends up copied into a comment, a worker doc, a README table and a test, so flipping it becomes a five-file diff. The see-it-fail test exposes it: to make the assertion go red you must break the thing it asserts, which is not a bug. "It exists", "it has the right shape" and "it is one of these" are the same test in a looser coat. Test the **behaviour the value drives** instead: feed the real code the declared value and assert what the code does with it — a task declared `weekly` is planned once across a fourteen-day clock, a check declared over `**/*.mjs` fires on a fixture `.mjs` and stays silent on a `.md`, a default object yields the documented output when nothing overrides it. Where no code reads the value there is nothing to test; if a declaration genuinely must not change without deliberation, that is a review concern, not a test. What *does* earn an assertion on declared data is a claim spanning two artifacts that could drift independently: the doc a field *names* exists; every signal the code reads is declared; two implementations of the same list agree; a value the runtime constrains is inside its legal set — proven by running the constraint, not by re-listing the set.
  (test-value-set)
- **Naming the thing a fixture stands for** - invent the name (`acme-pack`, `acme-user`,
  `acme.example`) wherever the case holds for any name at all, and keep a real one only where that
  entity is what the case asserts about: a borrowed name reads as meaningful, collides with the
  real thing's own cases, and makes every later rename an edit of tests that were never about it.
  (fixture-names-invented)
- **Testing a task's precondition or declaration** — assert only the pack's own code: a
  task-local term's decisions, a worker's behaviour, or a composition it designed; a plain
  built-in term or a validated declaration is the scheduler's own mechanism, proved once by its
  own suite. (testing-tasks-precondition)
- **Asserting on a record the code under test produced** - a finding, a parsed spec, a normalized declaration - assert the fields that code **computed**, and leave the ones it copied straight through from its own declaration or from your setup. A check selected by its id whose test then reads `finding.rule` back, or restates the `on_fail` its declaration set, is asserting the selector: it stays green however wrong the matching is, and goes red only when someone deliberately renames or re-grades the rule. One computed field identifies a record - the rest is your setup talking back to you.
  (asserting-record-code)
- **A coupling that must hold for every member of a set** — each task's id matching the directory it is discovered by, each check's `doc:` pointer resolving, each declaration validating — assert it once in a sweep that reads the whole set out of the tree, never in each member's own suite. The per-member copy only ever holds the members that happen to have a suite, so it under-covers and taxes at the same time: the shape is billed to each suite that has one while the members without one go unguarded.
  (coupling-must-hold)
- **Pinning the text a finding or error carries** — assert the part the code **derived** from the input (the version it tells you to bump to, the path it resolved, the term it names), and leave the static sentence alone. A remedy's wording is prose someone will improve, and asserted back it turns every rewording into a test edit while guarding nothing — those words were read straight out of the declaration the test already points at.
  (pinning-text-finding)
- **Sweeping a set** — a tree walk, a filter over a file's lines, a loop over discovered
  members — **pin how many members it covered**, beside the loop. An assertion reached only
  inside a loop, or only behind an `if`, says nothing about the members that never entered it,
  so a set that quietly shrinks — a renamed token, a moved directory, one call kind of two
  dropping out — leaves the survivors passing and reports that pass for the whole. A count read
  off the same source is the pin (`assert.ok(files.length >= 25)`), and a guard *inside* the
  loop needs its own, since the
  outer count says nothing about how many members reached the assertion behind it. (sweeping-set)
- **Reading the source *text* of a module the test could `import`** — asserting an identifier
  appears in it, or that one string precedes another in the file — inverts the signal: it goes
  red on a pure rename and stays green on a behaviour change that leaves the tokens in place.
  Grepping a *different* artifact is the two-artifact drift guard above and stays. Where the
  module is callable and a grep is still the only way in, report that its entry point does the
  whole job at once — that is worth more than the assertion. (reading-source-text)
- **Choosing the cases for a validator, parser or guard** — its own rejection branches are the
  list: for each, write the input that forces it. A branch nothing forces is either a promise
  no test holds or one the code can no longer reach, and both are worth finding. The gap
  clusters on the **present-but-unusable** input — the empty string, the directory that will
  not read, the module that throws on import — because absent and valid are the two cases
  everyone writes, while the field that is there and broken is the one that arrives in
  production. (choosing-cases-validator)
- **A comparison against a threshold, a deadline or an anchor instant** — test the value
  exactly **on** it, not only either side. `<=` and `<` differ on exactly one input, so a suite
  that samples comfortably around the boundary agrees with both and pins neither. Where a cron
  or a poll drives the comparison, that one input is the ordinary case rather than the edge: the
  run fires *at* the anchor. (comparison-against-threshold)
- Prefer a single shared double; but when a subsystem is faked by more than one (a minimal unit stub vs. a faithful harness that boots the real module), a new call into the faked surface must be taught to **every** double, or the untaught one breaks — and the faithful harness turns an unmodeled API into a confusing **far-away** failure (a DOM-snapshot pixel-diff, not a local error at the call site). After adding a call into a faked boundary, find every double of it and extend each.
  (prefer-single-shared)
- When one wire format, encoding, or algorithm is **implemented twice** — two languages, two tiers, a hand-rolled client encoder against the server's library — no compiler, type system, or single test run spans the two, so the only thing holding them together is a **shared vector set carried deliberately by both suites**: the same inputs and the same expected outputs, asserted independently on each side, including the boundary cases the two could plausibly round differently (a value exactly on a bisection midpoint, a tie, a truncation edge). A vector asserted on only one side is an input nobody ever compared — both suites stay green, in different languages under different runners, while the claim quietly stops covering it. So: touching *either* implementation re-runs *both* suites, and adding a vector adds it to both. Where the pairing is mechanical (the two vector lists must contain the same inputs), pin it with a check rather than a convention.
  (wire-format-encoding)
- A traceability/coverage gate that requires every spec item be *claimed* by some test of one fixed kind proves only that it's claimed, not that it's verified. When items differ in kind, the gate green-lights claims that kind can't check — a pixel snapshot "covers" a click's tab-opening it can never observe, or a state the case never renders (and can't, when the data can't reach it). Segment the gate by the verification each item needs (route behavior to a behavior test, rendering to a snapshot) rather than forcing every item onto one mechanism.
  (traceability-coverage-gate)
- A golden/snapshot test whose expected artifact is hand-authored to mirror what production renders is a parallel implementation: it drifts from the real output and can't catch changes to the renderer (a hand-built UI gallery even faked a state the app never shows). Drive the snapshot through the real code path, faking only its inputs.
  (golden-snapshot-test)
- A snapshot/golden test that depends on the current date/time must inject a fixed reference instant, not read the real clock — else a fixed-date fixture silently rots as wall-clock time passes ("this year" becomes "past" next year). Thread the reference time through the code under test, defaulting to the real clock in production. When retrofitting such a rule into an existing fixture suite, pin the reference instant so existing fixtures land on the same side they were authored for — so only the cases that deliberately exercise the new rule change and the diff stays small and reviewable, rather than a sprawling baseline churn that buries the intended change.
  (snapshot-golden-test-2)
- A round-trip test that asserts by comparing **serialized** forms (`JSON.stringify(decoded) === JSON.stringify(original)`) silently makes key *order* part of the contract: add a field at the top of the encoder's record and append it in the decoder's, and the round-trip fails on ordering alone — with a diff that reads like a data bug and sends you after a value that was correct all along. Deep-equal the parsed structures instead, so the test states what it means; keep serialized comparison only where byte-identity is genuinely the property under test, and say so in the test.
  (round-trip-test)
- A new **e2e / heavy-browser** test must go green at least twice in CI before merging — one green run doesn't rule out a flake. This applies only to that class (the real-Chrome `test/fullBrowserHeavyTests/` suites); the deterministic offline/unit/integration tests don't touch a live browser or network, so one green run is enough for them.
  (new-e2e-heavy)
- A test that can only run remotely (e.g. CI-only) must diagnose itself: on failure, dump the observed state, not just an assertion. It must also be *hang-proof* — bound every `await` (a timeout race) and set a test-level timeout — so a failure fails fast with that diagnostic instead of burning the whole job's timeout. An unbounded await on something that never settles (e.g. a callback that silently never fires) turns a 5-second failure into a 20-minute hang, and each CI-only iteration already costs a full round-trip.
  (test-can-only)
- **A shared fixture helper is paid for by every test that calls it**, so build the part that is identical for every case — a scratch repo's `init` and seed commit, a migrated database, a compiled bundle — once per process and copy it, rather than rebuilding it per test.
  (shared-fixture-helper)

- **A test runner parallelises across FILES, so one file's serial runtime is a floor no worker count clears.** When a suite's CPU sits well below its core count, the idle cores are waiting on that file — give it intra-file concurrency, which more workers cannot substitute for.
  (test-runner-parallelises)

- Run a suite you know is slow as **its own command with an explicit timeout well above its measured runtime**, and do the dependency install as a *separate, earlier* call. An agent shell caps a command at a default (order of a couple of minutes) and pushes it to the background when it expires; the reflex is then to start the suite over, so one green result costs double the wall clock with two suites racing each other. Chaining setup in front of the suite is what usually pushes the pair past the cap. If a run does get backgrounded, wait on the one already running rather than launching a second.
  (run-suite-know)
- To test code that drives a real browser or other external runtime in CI, prefer a *self-authored hermetic input* (e.g. a `data:` URL whose own script reproduces the behavior) over hitting a live third-party target — the live target is non-deterministic and often bot-blocked from a CI/datacenter IP, so it flakes or can't run, while a self-authored input exercises the same engine deterministically.
  (test-code-drives)
- Gate a fuzzy quality metric (a coverage %, not a binary pass) behind a high-watermark: refresh the artifact and ratchet the watermark up locally, keep CI read-only (assert against the committed baseline, never rewrite it), and re-baseline by hand only when a deliberate change legitimately moves it — a number that can only climb catches a silent regression without flapping on noise. When the population it covers can *grow* (e.g. new test cases), store the set the watermark was computed over and gate only over the cases shared with it, so a newly added item is excluded rather than dragging the aggregate below the bar; re-anchor the watermark when the set changes. (A single aggregate watermark can then be re-anchored over a regression bundled into the *same* change as a set change — store per-item bars if that must be caught.)
  (gate-fuzzy-quality)
- For behavior a person must sign off on (a third-party integration, an extraction result), keep a layer of declarative, human-reviewed expectation files — distinct from the unit tests, which nobody reads for *intent* — and cover every behavior change with a minimal, representative case there (one behavior per case, no incidental complexity), since that case is what gets reviewed.
  (behavior-person-must)
- When a snapshot/golden test fails because the output *legitimately* moved (the pixels or bytes changed for a real reason), don't quietly regenerate the baseline to go green — an unreviewed baseline change is an unreviewed behavior change. Surface the diff (committed **expected**, newly-rendered **actual**, highlighted **diff**) and get owner approval before re-baselining; until then keep the *reverted* baseline committed so the branch honestly shows the test red-pending — never commit the new baseline first.
  (snapshot-golden-test)
- When a test asserts exact values extracted from a captured artifact (a cached page, a recorded response), record and commit the artifact *first*, then read the expected values off the committed file — don't hand-write the expectations from memory or a live view and hope they match. Guessing the value desyncs the test from the real fixture; reading it off the committed bytes can't.
  (test-asserts-exact)
- A test that maintains a committed artifact should regenerate it into the working tree deterministically (no timestamps, so an unchanged run yields no diff) and skip the write under CI — never shell out to git from a test. Commit the artifact through the normal review flow, like a snapshot.
  (test-maintains-committed)
- Render a UI *image* golden with the engine that matches the surface, and prefer the deterministic one. A surface that is inline-styled SVG, or flexbox-only markup authored for it, renders **bit-exact** through a headless rasterizer (e.g. satori → SVG, resvg → PNG) driven by the shipped code, using **bundled** fonts, never system fonts, and a pinned locale — demand a **zero-pixel** diff there. But that rasterizer has no CSS engine and draws no native widgets: a full shipped page using CSS **grid**, custom properties (`var()`), `@media`, **emoji**, or **form controls** (a range slider, radio, `<select>`) is beyond it — screenshot that with a **headless browser** instead, and allow a *small* diff tolerance (browser antialiasing varies across machines, so it isn't bit-exact). Match the engine to the surface; never reshape the product to fit the rasterizer. (A rasterized popup golden works only because the popup was authored flexbox-only — the moment a surface needs grid/vars/widgets, it needs a browser.) Since the browser goldens aren't gate-able bit-exact and a runner may lack the browser, let those cases **self-skip** where it's absent so the deterministic cases still gate.
  (render-ui-image)
- Reproduce a reported golden-image flake with the harness's own pixel comparator, never a raw byte or file-hash compare: a byte-hash is strictly tighter than a zero-pixel-diff comparator (it also fails on identical pixels re-encoded differently), so it manufactures "reproductions" of a flake that never fails the real gate.
  (reproduce-reported-golden)
- To image-golden a surface your code **injects into a host page** (a control mounted into a third-party toolbar), render it against a **committed capture of the real host DOM with its computed styles flattened inline** — the deterministic rasterizer reads only inline styles, and the host's own stylesheet is not yours to ship. Mount it with the **shipped injector** (so the golden proves the placement, not a hand-placed copy), and name the model's boundary honestly: substituted icon-font glyphs, an approximated host chrome (a captured sample is spec, not folklore — the origin lesson of a supported-targets matrix).
  (image-golden-surface)
