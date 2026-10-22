# Signing, the index and revocation

How a member repository learns what exists, proves what it fetched, and hears that something is
wrong. Requirements: [../requirements/cn-client-contract.md](../requirements/cn-client-contract.md).

## The registry key

Ed25519. PackServer always holds an **active** key and a **standby** key: the active private half is
in Secrets Store bound only to the validator; the standby was generated offline, its public half is
embedded in cn beside the active one, and its private half sits in Secrets Store with no Worker
binding until promoted. Every signature carries `kid`. A planned rotation publishes the next
standby's `kid` in a cn release, then promotes. An emergency promotion is an irreversible change
([../operations/release.md](../operations/release.md)) that takes under an hour: bind the standby
to the validator, re-sign every index and private fragment, publish `index/v1/keys.json` naming the
retired `kid` with `status: revoked` and `revoked_at`, generate the next standby. cn removes a
revoked `kid` from its trusted set and refuses anything it signed, even what verifies (REQ-CN-003).
Any Cloudflare audit event that binds either key to a Worker other than the validator pages
(`page.signing_key_read`). Sigstore is used only for audit chain heads, never for pack signing: a
registry key is what cn can verify offline with no network and no transparency-log client.

## Attestation

`.attestation.json` beside each archive, signed by the registry key:

```json
{
  "pack": "@acme/gcp", "version": "1.61021.1",
  "upload_sha256": "…", "canonical_sha256": "…",
  "provenance": {"repository": "acme/packs", "repository_id": 1234567, "commit": "…",
                 "ref": "refs/tags/gcp/1.61021.1", "event": "push", "workflow_run": "…",
                 "path": "packs/gcp", "source": "oidc" | "upload", "source_verified": true},
  "rules_version": "2026.10.3", "validated_at": "…", "kid": "2026-10"
}
```

The upload hash lets a publisher who kept their client's hash check that the canonical archive was
made from it; the canonical hash is what cn verifies. `source_verified` says the validator fetched
the repository tree at `commit` and found the pack's path identical to the validated tree
(REQ-PUB-006); an upload has `source: upload` and no repository claims.

## Index layout (`index/v1`)

Every signed document carries `generated_at`, `expires` (`generated_at` + 7 days) and a
monotonically increasing `serial`. `root.json` lists every public scope with the SHA-256 and serial
of its current scope index, and is re-signed on every change and at least once a day
(`RootCoordinator`, [data-stores.md](data-stores.md)). A scope index lives at
`index/v1/<scope>/<sha256>.json`, content-addressed and immutable, so cn fetches the root and then
exactly the object the root names and a stale root yields a consistent, slightly old pair, never a
mismatch (ARCH-REV H1). `index/v1/<scope>.json` is a human alias cn never reads. The scope index
lists the scope's packs; per pack: name, `latest_eligible` (never a yanked, quarantined or removed
version), and its versions, each with:

```
version, sha256, size, published_at,
status: active | deprecated | yanked | quarantined | revoked,
reason (for any status but active), security (for revoked),
verified, verified_domain, verified_github_org, source_verified,
min_engine_version, requires, source_commit,
preinstall: {guards: [{name, tool_calls}], tasks: [{name, cadence, opens_pr, agentic_phase}],
             forced_skills, github_actions, new: [...]}
```

A scope index carries at most the 20 newest eligible versions of each pack plus any version whose
status changed from `active` in the last 180 days; the full history is the pack's signed
`@scope/name/versions.json` (ARCH-REV M11). A removed pack stays listed with `status: removed` so
clients de-index. A change to a scope's proofs re-signs its index because the verification facts
live in every entry. The root is served with `max-age=60, stale-while-revalidate=300,
stale-if-error=86400`; scope indexes and archives are `immutable`.

cn's read: fetch `root.json`, verify signature, `expires` and `serial`; follow the hash to the scope
index, verify; select by semver precedence among eligible versions satisfying `min_engine_version`
and `requires`; download; verify sha256; extract only the canonical form; vendor into
`.claudinite/shared/packs/<scope>/<name>/`. A serial lower than the last verified one is refused as
`index.rollback`; past `expires` cn reports `index.stale` and after a further 7 days treats every
status as unknown (REQ-CN-002). On any fetch failure cn serves from its last good indexes.

## Private indexes

A private pack is in no public index. At promotion, and on every status or proof change, the
validator signs one **private entry** per private pack (`kind: private`, the pack's opaque version
ids, the same fields as a public entry, `generated_at`, `expires`, `serial`) into
`packs-private`. `GET /api/private/index` performs the access check (Actions OIDC
`repository_owner_id` on the allowlist, a GitHub-signed-in person's account id, or a `psr_` token)
and returns the entries the caller may read inside an unsigned envelope marked private and
non-storable; the serving Worker signs nothing and holds no key (REQ-PRIV-020). cn verifies each
entry and never accepts a private entry on a public path or a public index as a private entry.
Downloads are streamed or presigned for 5 minutes and addressed by the opaque version id.

## Statuses and what cn does

| Status | Set by | Index | Fetch | cn behaviour |
|---|---|---|---|---|
| `active` | promotion | listed, eligible | yes | normal |
| `deprecated` | publisher, with reason | listed, eligible by exact version | yes, reason shown | report in the update PR |
| `yanked` | publisher or moderation, with reason | listed, never newest | by exact version only, `yanked: true` | report |
| `quarantined` | rescan finding, abuse hold, admin, judge auto-hold | listed, never newest | held, 451-style with reason; `get_pack` says `under_review` | report |
| `revoked` | human only, security reason | listed | no | disable guards, checks, tasks and env setup; prose behind a banner; unless `revocation: reportOnly` |
| `removed` | publisher delete or moderation | `status: removed` | no | report and de-index |

Quarantine is reversible and automatic; revocation is a human decision because it disables code in
member repositories. cn acts on status when it next reads the index, at adopt and in the update
task, and records what it found in the repository tree so sessions read the status without a fetch;
nothing is fetched at session time (docs/decisions.md D31).

## Canonical form

The validator re-packs the validated tree deterministically in the first sandbox: sorted paths,
fixed metadata, plain entry names, one zstd frame, window at most 8 MB, pinned compression level.
The tree hash is committed to D1 before the second sandbox runs any pack code, and that sandbox
re-extracts the canonical archive with the same bounded decoder and must find the same hash
(REQ-VAL-051). cn extracts only this form and refuses anything a lenient extractor would also
accept, which closes parser differentials between the registry's extractor and cn's.
`cn pack canonicalise` reproduces the bytes offline.

## Verify by hash

`GET /api/verify/<sha256>` answers whether a hash is the canonical or upload hash of a published
version, which, and the version's current status; unknown hashes answer "unknown"; the endpoint is
rate-limited per IP and reveals nothing about private packs.
