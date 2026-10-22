# Telemetry

Area `TELEM`, 7 requirements. Format and rules: [README.md](README.md).

The signals these entries name are asserted through `world.telemetry` ([../testing/dsl.md §7](../testing/dsl.md)). The names themselves are defined in `docs/operations/monitoring.md` §8 (branch `claude/project-thread-bwothd`, unmerged), which is authoritative; a scenario for an entry here uses the name from that section (for example the download signal for REQ-TELEM-001 and REQ-TELEM-002, the rollup signal for REQ-TELEM-003). An entry here says what is counted; monitoring §8 says what the count is called.

## REQ-TELEM-001 Downloads and index fetches are counted without blocking

- status: active
- since: 2026-10
- actor: system
- source: DATA Analytics Engine
- coverage: scenario

Each download and index fetch is counted (pack, version, hashed caller, fetcher: `cn adopt`, the
update task or MCP) without blocking the response.

## REQ-TELEM-002 A download counts once per caller, version and day

- status: active
- since: 2026-10
- actor: system
- source: FLOW 11
- coverage: scenario

A download is counted once per (caller, version, day) toward the downloads metric.

## REQ-TELEM-003 30-day fetches roll up hourly

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH §3, §10; DATA
- coverage: scenario

30-day fetch counts are rolled up at least hourly and shown on the pack page, browse cards and
MCP cards.

## REQ-TELEM-004 Counts are approximate; tests assert monotonic behaviour

- status: active
- since: 2026-10
- actor: system
- source: DATA Analytics Engine
- coverage: scenario (asserts monotonic, order-of-magnitude behaviour only)

Counts are approximate by design; a test asserts monotonic, order-of-magnitude behaviour, not
exact totals.

## REQ-TELEM-005 The publisher dashboard shows per-pack status and alerts

- status: active
- since: 2026-10
- actor: publisher
- source: SITE dashboard
- coverage: scenario

The publisher dashboard shows per pack: visibility, latest version, status, stars, downloads and
open issues, plus an alerts strip (failed validations, pending payments, expiring verification,
security reports).

## REQ-TELEM-006 Telemetry never stores raw IPs

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA
- coverage: scenario

Raw IP addresses are never stored in telemetry; only hashes.

## REQ-TELEM-007 A weekly scan of public repositories counts the repos declaring each pack

- status: active
- since: 2026-10
- actor: system
- source: ARCH §10, §15 Q10 (PR #3 commit 359f3c6); Ariel, 2026-10-22 (cn sends no telemetry; a weekly public-repo scan instead)
- coverage: scenario+contract (the scenario drives the fake GitHub code search, the cursor and the timeout; the real query shapes against GitHub's code-search limits are the weekly contract suite)

cn sends no telemetry and PackServer never reads a private repository. Once a week the github
Worker searches public repositories through GitHub code search for Claudinite settings files and
records, per pack, the number of repositories declaring it, the versions they pin and the
declarations dropped since the previous scan. A run stops after 10 minutes and the next one resumes
from its saved cursor; it uses a read-only public-repository token and splits its queries by pack
id and repository creation date to stay within code-search limits. The counts feed Trending,
ranking and the pack page.

