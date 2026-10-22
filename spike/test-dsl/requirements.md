# Requirements register (spike subset)

Same entry format as `docs/requirements/` (`## REQ-X-NNN Title`, then a `- status:` list item).
Real IDs are copied from the register; `REQ-SPIKE-*` entries exist only to exercise the tooling
and must not be read as product requirements.

Rules the tooling enforces (`scripts/check-scenarios.mjs`, vitest strict tags):
every `active` requirement here is named by at least one scenario title under `tests/scenarios/`,
and every scenario names a requirement listed here (any status).

## REQ-PRIV-001 A private pack is indistinguishable from a nonexistent one

- status: active
- source: docs/requirements/private.md

## REQ-SEARCH-001 Anonymous MCP access to public search and download tools

- status: active
- source: docs/requirements/search-mcp.md

## REQ-SEARCH-013 Website search and browse mirror MCP results and filters

- status: active
- source: docs/requirements/search-mcp.md

## REQ-VAL-001 Every upload is validated with live progress

- status: active
- source: docs/requirements/validation.md
- note: the spike covers only "the verdict is attached"; progress is out of scope

## REQ-SPIKE-001 Publishing requires a signed-in user

- status: active
- note: spike-only stand-in; the real register expresses this through tokens/MFA (REQ-ACC-008, REQ-PUB-013)

## REQ-SPIKE-002 Every external call and every write is recorded in order

- status: active
- note: spike-only; backs the release plan's wet-run/dry-run recording, not a product requirement

## REQ-SPIKE-003 A provisional requirement may have no scenario yet

- status: provisional
- note: present to prove the check only demands scenarios for active entries
