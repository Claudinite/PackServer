# Signing, the index and revocation

How a member repository learns what exists, proves what it fetched, and hears that something is
wrong. Requirements: [../requirements/cn-client-contract.md](../requirements/cn-client-contract.md).

## The registry key

One Ed25519 key pair, the private half in Secrets Store bound only to the validator, the public half
embedded in cn as a key set. Every signature carries `kid`. Rotation publishes the new `kid` in a cn
release before the registry signs with it, then overlaps, then retires the old key. Sigstore is used
only for audit chain heads, never for pack signing: a registry key is what cn can verify offline with
no network and no transparency-log client.

## Attestation

`.attestation.json` beside each archive, signed by the registry key:

```json
{
  "pack": "@acme/gcp", "version": "1.61021.1",
  "upload_sha256": "…", "canonical_sha256": "…",
  "provenance": {"repository": "acme/packs", "commit": "…", "ref": "refs/tags/gcp/1.61021.1",
                 "workflow_run": "…", "path": "packs/gcp", "source": "oidc"},
  "rules_version": "2026.10.3", "validated_at": "…", "kid": "2026-10"
}
```

The upload hash lets a publisher who kept their client's hash check that the canonical archive was
made from it; the canonical hash is what cn verifies.

## Index layout (`index/v1`)

`root.json` lists every public scope with the SHA-256 of its scope index and is signed.
`<scope>.json` lists the scope's packs; per pack: name, `latest_eligible` (never a yanked,
quarantined or removed version), and its versions, each with:

```
version, sha256, size, published_at,
status: active | deprecated | yanked | quarantined | revoked,
reason (for any status but active), security (for revoked),
verified, verified_domain, verified_github_org,
min_engine_version, requires, source_commit,
preinstall: {guards: [{name, tool_calls}], tasks: [{name, cadence, opens_pr, agentic_phase}],
             forced_skills, github_actions, new: [...]}
```

A removed pack stays listed with `status: removed` so clients de-index. A change to a scope's
proofs or badge re-signs its index because the verification facts live in every entry. Indexes are
rewritten through `ScopeCoordinator` to coalesce bursts and served with
`max-age=60, stale-while-revalidate=300, stale-if-error=86400`; archives are immutable.

cn's read: fetch `root.json`, verify, follow the hash to the scope index, verify, select by semver
precedence among eligible versions satisfying `min_engine_version` and `requires`, download, verify
sha256, extract only the canonical form, vendor. On any fetch failure cn serves from its last good
indexes.

## Private indexes

A private pack is in no public index. `GET /api/private/index` builds a per-caller index from D1
after the access check (Actions OIDC `repository_owner_id` on the allowlist, a GitHub-signed-in
person's account id, or a `psr_` token) and signs it the same way; it is marked private and
non-storable. Downloads are streamed or presigned for 5 minutes.

## Statuses and what cn does

| Status | Set by | Index | Fetch | cn behaviour |
|---|---|---|---|---|
| `active` | promotion | listed, eligible | yes | normal |
| `deprecated` | publisher, with reason | listed, eligible by exact version | yes, reason shown | report in update PR and session start |
| `yanked` | publisher or moderation, with reason | listed, never newest | by exact version only, `yanked: true` | report |
| `quarantined` | rescan finding, abuse reports, admin, judge auto-hold | listed, never newest | held, 451-style with reason; `get_pack` says `under_review` | report |
| `revoked` | human only, security reason | listed | no | disable guards, checks, tasks and env setup; prose behind a banner; unless `revocation: reportOnly` |
| `removed` | publisher delete or moderation | `status: removed` | no | report and de-index |

Quarantine is reversible and automatic; revocation is a human decision because it disables code
in member repositories. cn acts on status when it next reads the index: at adopt, in the update
task, and in the bounded, cached read at session start.

## Canonical form

The validator re-packs the validated tree deterministically: sorted paths, fixed metadata, plain
entry names, one zstd frame, window at most 8 MB, pinned compression level. Before promotion the
sandbox re-extracts it with the same bounded decoder and compares tree hashes. cn extracts only
this form and refuses anything a lenient extractor would also accept, which closes parser
differentials between the registry's extractor and cn's. `cn pack canonicalise` reproduces the bytes
offline.

## Verify by hash

`GET /api/verify/<sha256>` answers whether a hash is the canonical or upload hash of a published
version, which, and the version's current status; unknown hashes answer "unknown"; the endpoint is
rate-limited per IP and reveals nothing about private packs.
