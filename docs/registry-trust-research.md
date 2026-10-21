# How package registries tell users a package is safe

Researched 2026-10-15. Living copy: [Claude Doc](https://claude.ai/code/artifact/4bd763d3-84db-4adc-9a89-4cdb69e0b9bc).

## Summary

No major public registry guarantees that a package is safe. npm says it outright: provenance "does not guarantee the package has no malicious code." What registries do guarantee is narrower: **the bytes you get are the bytes that were published, and a published version never changes.**

On top of that guarantee they layer five kinds of signal:

1. **Identity and origin.** Who published it and which CI run built it: Sigstore provenance on npm and PyPI, Trusted Publishing on npm, PyPI and crates.io, verified-publisher badges on VS Code and Docker.
2. **Gates before publish.** These are mostly about form, not safety. Maven Central demands signatures, sources, javadoc and full metadata. Homebrew core alone requires a test that passes on its CI. The app-style stores (VS Code, Chrome) add malware and secret scans or human review.
3. **Takedown after publish.** Malware is removed, quarantined or blocklisted. Only the editor and browser stores also *disable it on users' machines*.
4. **Advisories.** Public feeds (GitHub Advisory Database, RustSec, OSV) flag bad versions to tools like Dependabot and `npm audit`.
5. **Reputation.** Downloads, stars and third-party scores (OpenSSF Scorecard, Socket) are mostly not computed by the registry itself.

The closest analogue to packs is agent plugin and skill marketplaces. There, malware scans proved blind: ClawHub found 341 malicious skills out of 2,857, and its maintainers say a scan cannot catch a skill that tells the agent to do harm in plain language.

## Comparison

Only Homebrew requires tests, and only the editor and browser stores review content before it goes public. Rows run from code registries (least vetting) to app stores and agent marketplaces.

| Registry | Checked before publish | Tests required | Provenance and signing | When a package turns out bad | Ranking shown |
| --- | --- | --- | --- | --- | --- |
| [npm](https://docs.npmjs.com/policies/unpublish) | Publisher auth only: 2FA or Trusted Publishing; publish tokens capped at 7 days since Sept 2025 | No | Sigstore provenance plus registry publish attestation; `npm audit signatures` verifies | Malware removed and filed as a GitHub malware advisory; author can unpublish within 72 h or deprecate (warning on every install) | Weekly downloads, dependents |
| [PyPI](https://docs.pypi.org/attestations/) | Publisher auth; no content review | No | PEP 740 attestations (SLSA provenance + publish) signed by the Trusted Publisher | Admin quarantine: ~140 projects since Aug 2024, all but one malware; author can yank a version | None on the site |
| [crates.io](https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07/) | Publisher auth; Trusted Publishing via GitHub Actions since July 2025 | No | Tokens from OIDC, no signatures | Malware removed, account banned, RustSec advisory filed; author can yank | Downloads |
| [Go modules](https://go.dev/ref/mod) | Nothing; there is no upload, the proxy fetches from the repo | No | Checksum database: a public Merkle-tree log, clients verify inclusion proofs | Author publishes `retract`; old builds keep working, `go get` stops choosing it | Imported-by count |
| [Maven Central](https://central.sonatype.org/publish/requirements/) | PGP signature and checksums on every file; sources and javadoc jars; full POM metadata; verified namespace | No | PGP signatures | Versions immutable; no author takedown | None |
| [Homebrew core](https://docs.brew.sh/Acceptable-Formulae) | Maintainer review of a pull request; stable, immutable upstream release; SHA-256 on downloads | **Yes**: must build and pass its test on the CI matrix | Homebrew builds and hosts the binaries itself | Removed by pull request | Install analytics |
| [Docker Hub](https://docs.docker.com/docker-hub/repos/manage/trusted-content/) | Nothing for ordinary images; Official Images are curated | No | Badges for Official, Verified Publisher, Sponsored OSS | Vulnerability analysis (Docker Scout) for badge holders | Pulls, stars |
| [VS Code Marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security) | Multi-engine malware scan before public; secret scan blocks publish | No | Marketplace signs every extension; verified publisher = domain proof + 6 months good standing | Blocklisted and **auto-uninstalled** from users' editors | Installs, ratings |
| [Chrome Web Store](https://developer.chrome.com/docs/webstore/review-process) | Automated + manual review of every new item and update; deeper for new developers, broad permissions, big code changes | No | Store-signed | Takedown; **remote disable** on users' browsers, and malware cannot be re-enabled | Users, ratings |
| [Claude Code plugins](https://code.claude.com/docs/en/plugins/security) | Official tier curated by Anthropic; community tier pinned to a commit SHA; third-party unchecked | No | Optional sha256 archive pin; reserved marketplace names | Trust warning on every install; orgs can allow- or blocklist marketplaces | None |
| [ClawHub (OpenClaw skills)](https://www.openclaw.ai/blog/virustotal-partnership) | VirusTotal hash lookup plus LLM code analysis: benign auto-approved, suspicious warned, malicious blocked | No | None | Every active skill re-scanned daily | Downloads, stars |

## What each mechanism actually promises

**Tests.** No language registry runs a package's tests. Homebrew core is the exception: a formula "must build and pass its tests on the current homebrew/core continuous-integration matrix", and Homebrew then builds and hosts the binaries itself. Tests on the other registries are only an input to third-party scores: OpenSSF Scorecard has a "CI Tests" check.

**Provenance and attestations.** npm and PyPI attach Sigstore-signed statements saying which repository and CI run built the file, logged in a public transparency log. They prove origin, not intent: npm's docs say provenance "does not guarantee the package has no malicious code." Trusted Publishing (npm, PyPI, crates.io) replaces long-lived tokens with short-lived CI credentials. That closes the stolen-token route the 2025 Shai-Hulud worm used.

**Integrity.** Every registry makes a published version immutable: npm never reuses a name@version, even after an unpublish. Go goes furthest. Its checksum database is a Merkle-tree log that clients verify with inclusion and consistency proofs, so even an untrusted proxy "can't serve the wrong code without it going unnoticed."

**Public invalidation.** There are three strengths:

- **Author marks it bad.** npm deprecate, PyPI and crates.io yank, Go `retract`. Existing pinned builds keep working; new resolutions avoid it or warn.
- **Registry removes it.** Malware is deleted or quarantined, the account is banned, and an advisory is published. PyPI's quarantine is the reversible version.
- **Store disables it on the device.** VS Code auto-uninstalls blocklisted extensions. Chrome remotely disables them, and malware "cannot be re-enabled". Only stores that control the client can do this.

**Advisories.** The [GitHub Advisory Database](https://docs.github.com/en/code-security/security-advisories/working-with-global-security-advisories-from-the-github-advisory-database/about-the-github-advisory-database) covers 12 ecosystems. Malware advisories come from the npm security team and the OpenSSF Malicious Packages repository; they have no fixed version, so the only remedy is removal. Dependabot alerts on reviewed advisories and malware, not unreviewed ones.

**Trust badges.** These are identity, not quality. The VS Code check mark means proven domain ownership plus six months in good standing. Docker's Verified Publisher badge also buys search priority. Homebrew core and Docker Official Images are the only curated tiers.

**Ranking.** Registries show raw counts (downloads, installs, dependents, stars). Composite scores come from outside: [OpenSSF Scorecard](https://scorecard.dev/) runs 18 checks on a project's repository (branch protection, code review, signed releases, pinned dependencies). [Socket](https://docs.socket.dev/docs/package-scores) scores supply-chain risk, quality, maintenance, vulnerabilities and license, capping a category when a critical alert fires.

## Closest analogues to packs

Packs are closest to agent plugins and skills, not to libraries. A pack carries both code that runs (checks, task commands, env steps, hooks) and prose the agent obeys. Agent marketplaces show the prose half is where scanning fails.

- **Claude Code plugins.** The [docs](https://code.claude.com/docs/en/plugins/security) say a plugin "can execute arbitrary code on your machine" and that skills "enter Claude's context as instructions". Every install shows a warning that Anthropic "cannot verify that they will work as intended or that they won't change." The safeguards are tiers and pins: the official and community names are reserved for `github.com/anthropics/` sources, the community catalog pins nearly every entry to a commit, and archive sources can pin a sha256. Auto-update is called out as a way reviewed files change under you.
- **ClawHub (OpenClaw skills).** [Koi Security found 341 malicious skills out of 2,857](https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html) in Feb 2026, 335 from one campaign that used fake "prerequisites" to get the user to install a macOS stealer. ClawHub [answered with VirusTotal scanning](https://www.openclaw.ai/blog/virustotal-partnership) and an LLM review starting from SKILL.md, plus daily rescans. Its own post says "A skill that uses natural language to instruct an agent to do something malicious won't trigger a virus signature" and "A clean scan doesn't mean a skill is safe."
- **VS Code and Chrome stores.** They are the only registries that review content and can remove a bad item from users' machines. They can do that because they own the client, as cn owns the engine that loads packs.
- **Homebrew core.** It is the only registry that requires a passing test and builds the artifact itself, at the cost of a maintainer reviewing every pull request.

## Questions this raises for Claudinite packs

Yes, we can require more than a file registry can, because a pack has a known format and cn loads it. These are the decisions the research puts on the table, not a design.

1. **Should a pack have to pass our own CI before it is listed, Homebrew-style?** We could run the same load and self-test that already refuses a pack that fails to load, plus schema validation of its manifest and declared checks.
2. **Should every check ship tests that run at submission?** For example, a fixture it must fire on and one it must stay silent on. No registry does this today; Homebrew comes closest.
3. **Should publishing require Trusted Publishing from a GitHub repo, with the source commit recorded in our signed index?** That gives npm/PyPI-grade origin proof, which is still not proof of safety.
4. **Should a pack declare its capabilities (runs code in Actions, env steps at session start, hooks, network), with an update that adds one held for review?** Ariel closed permission declarations in the first security review. Public submissions are a different threat than our own canon, so this may be worth reopening.
5. **How deep should the prose review go?** ClawHub shows an LLM review is needed and still not sufficient. The [hosting cost estimate](hosting-cost-estimate.md) puts a Sonnet review of every version at about $2,900 a month for 1M repos.
6. **Should a revoked pack be disabled on members, VS Code-style, or only reported?** We own the client, so we can do either. The fleet's existing `reportOnly` default for held versions is the precedent for reporting only.
7. **What ranking do we show?** Stars are weak. We have signals no registry has: how many repos keep a pack, how often its checks fire, and how often members drop it.
8. **Do we want tiers like Claude Code's?** For example: canon (curated by us), community (pinned, scanned, tested) and third-party (unchecked, with a warning).

## Sources

All opened on 2026-10-15 unless marked.

- [npm: Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)
- [npm: Unpublish policy](https://docs.npmjs.com/policies/unpublish)
- [Help Net Security: After Shai-Hulud, GitHub tightens npm publishing security](https://www.helpnetsecurity.com/2025/09/23/npm-publishing-security-improvements/) (search summary only)
- [PyPI: Attestations](https://docs.pypi.org/attestations/)
- [PyPI blog: Project quarantine](https://blog.pypi.org/posts/2024-12-30-quarantine/) (search summary only)
- [crates.io development update, July 2025](https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07/)
- [RustSec: RUSTSEC-2025-0155](https://api.osv.dev/v1/vulns/RUSTSEC-2025-0155) (search summary only)
- [Go Modules Reference](https://go.dev/ref/mod)
- [Maven Central: Requirements](https://central.sonatype.org/publish/requirements/)
- [Homebrew: Acceptable Formulae](https://docs.brew.sh/Acceptable-Formulae)
- [Docker: Trusted content](https://docs.docker.com/docker-hub/repos/manage/trusted-content/)
- [VS Code: Extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)
- [Chrome Web Store: Review process](https://developer.chrome.com/docs/webstore/review-process)
- [Claude Code: Plugin security and trust](https://code.claude.com/docs/en/plugins/security)
- [OpenClaw: VirusTotal partnership](https://www.openclaw.ai/blog/virustotal-partnership)
- [The Hacker News: 341 malicious ClawHub skills](https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html) (search summary only)
- [GitHub Advisory Database](https://docs.github.com/en/code-security/security-advisories/working-with-global-security-advisories-from-the-github-advisory-database/about-the-github-advisory-database)
- [OpenSSF Scorecard](https://scorecard.dev/)
- [Socket: Package scores](https://docs.socket.dev/docs/package-scores)
- [MCP Registry preview](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/): metadata catalog; moderation by community reports and a denylist
