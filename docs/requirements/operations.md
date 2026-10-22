# Operations: probes, self-test and the production configuration

Area `OPS`, 4 requirements. Format and rules: [README.md](README.md).

These entries come from the security review of the test plan (2026-10-22) and bind the test plan to the release plan (PR #8, `docs/release/README.md`) and the monitoring plan (`docs/operations/monitoring.md`). The release plan adds the self-test response-shape entries to this file with the next numbers.

## REQ-OPS-001 A synthetic scope is invisible outside itself

- status: active
- since: 2026-10
- actor: anonymous visitor / agent / cn
- source: SEC (security review, 2026-10-22); `docs/testing/README.md` §4.2; monitoring §10.1
- coverage: scenario

A synthetic scope (`@probe` is one) is excluded from public search, browse, the public indexes,
semantic search, ranking, exploration, sitemaps, telemetry rollups and billing; a synthetic
publish skips the LLM step and the human queue; a synthetic version expires after 24 hours and
its name may be reused.

## REQ-OPS-002 A probe credential cannot act outside its scope

- status: active
- since: 2026-10
- actor: CI workflow (security)
- source: SEC (security review, 2026-10-22); release plan §5.2, §10
- coverage: scenario

The probe identity is a publish token restricted to the synthetic scope with `publish:update`
only; it cannot create packs elsewhere, read private packs, mint tokens or perform any account
or session action, and it is never a human session.

## REQ-OPS-003 The production configuration rejects test issuers and test bindings

- status: active
- since: 2026-10
- actor: system (security)
- source: SEC (security review, 2026-10-22); `docs/testing/README.md` §5
- coverage: scenario+unit (a scenario boots the production-environment configuration in the harness and proves a token from the test issuer is refused; a unit test checks the build-time grep list)

Under the production environment the registry verifies OIDC tokens against GitHub's issuer only,
refuses a webhook secret that looks like a test value, and no test clock, test binding, test
entrypoint or test mode exists in the deployed bundles.

## REQ-OPS-004 Self-test is invisible to anonymous callers and does no paid work

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); release plan §5
- coverage: scenario+http (in-process for the refusal and the read-only property; the nightly http run proves it on the deployed host)

The self-test endpoint answers an anonymous caller exactly as an unknown path; it is served only
to the release flow's credential or to a calling Worker across a service binding; it is
read-only, makes no paid or external call, and in production reports check names and pass/fail
only.
