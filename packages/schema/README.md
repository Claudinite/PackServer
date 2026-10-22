# @packserver/schema

Zod shapes and contracts (`src/shapes`, `src/contracts`) and the D1 `registry` schema (`src/db`, `migrations/`). The Drizzle schema is the `@packserver/schema/db` subpath so shape users do not load `drizzle-orm`.

## Adding a migration

One migration per PR, written as a Drizzle schema change in `src/db/<area>.ts`:

1. Edit the area's schema file; the barrel `src/db/index.ts` already exports every area.
2. `pnpm --filter @packserver/schema db:generate --name <area>_<what>` writes `migrations/YYYYMMDDHHMMSS_<area>_<what>.sql` and its `meta/` snapshot.
3. `pnpm --filter @packserver/schema gen:range` regenerates `src/range.ts` (`SCHEMA_MIN`, `SCHEMA_MAX`, REQ-OPS-011); never edit it.
4. `pnpm db:check` runs `tools/check-migrations.mjs`, `drizzle-kit check` and a drift guard that fails when `drizzle-kit generate` would still produce a migration; `pnpm db:migrate --local` applies everything to a local D1 without a Cloudflare account.

Wrangler applies files in name order, so a migration depends only on the foundation tables (the
`foundation` area) or on its own area's earlier files. Cross-area foreign keys point at foundation
tables only (`users`, `scopes`, `packs`, `pack_versions`). Foundation tables, `credentials` included, are altered only by `*_foundation_*` migrations: a later foundation file may `ALTER` them but only the first may `CREATE` them, and another area's file that alters one is rejected. `check-migrations` rejects duplicate timestamp prefixes, references to tables no earlier
file created and cross-area references.

## Migrations a running Worker cannot survive

A deploy applies migrations before it replaces the Worker, so the previous code serves against the new
schema. `DROP TABLE`, `DROP COLUMN`, `RENAME`, `ADD COLUMN ... NOT NULL` without a default and a Drizzle table rebuild that drops a column break that
window, so they take three merges: an additive expand, a merge that moves the readers, and a later
contract. The contract file starts with

```
-- contract-of: <the already-shipped expand>.sql
```

and `check-migrations` rejects the statements above without it, rejects a marker that does not name an
earlier non-contract expand (not the table-creating foundation file) that touched the same table, and rejects a marker on a migration that is safe. `SCHEMA_MIN` is the newest migration that is
not a contract, so a build reading an expand's column requires that expand.
