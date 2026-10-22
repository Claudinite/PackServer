# @packserver/schema

Zod shapes and contracts (`src/shapes`, `src/contracts`) and the D1 `registry` schema (`src/db`, `migrations/`).

## Adding a migration

One migration per PR, written as a Drizzle schema change in `src/db/<area>.ts`:

1. Edit the area's schema file; the barrel `src/db/index.ts` already exports every area.
2. `pnpm --filter @packserver/schema db:generate --name <area>_<what>` writes `migrations/YYYYMMDDHHMMSS_<area>_<what>.sql` and its `meta/` snapshot.
3. `pnpm --filter @packserver/schema gen:range` regenerates `src/range.ts` (`SCHEMA_MIN`, `SCHEMA_MAX`, REQ-OPS-011); never edit it.
4. `pnpm db:check` runs `tools/check-migrations.mjs` and `drizzle-kit check`; `pnpm db:migrate --local` applies everything to a local D1 without a Cloudflare account.

Wrangler applies files in name order, so a migration depends only on the foundation tables (the
`foundation` area) or on its own area's earlier files. Cross-area foreign keys point at foundation
tables only; `check-migrations` rejects duplicate timestamp prefixes, references to tables no earlier
file created and cross-area references.

## Migrations a running Worker cannot survive

A deploy applies migrations before it replaces the Worker, so the previous code serves against the new
schema. `DROP TABLE`, `DROP COLUMN`, `RENAME` and `ADD COLUMN ... NOT NULL` without a default break that
window, so they take three merges: an additive expand, a merge that moves the readers, and a later
contract. The contract file starts with

```
-- contract-of: <the already-shipped expand>.sql
```

and `check-migrations` rejects the statements above without it, rejects a marker naming a file that is
not earlier, and rejects a marker on a migration that is safe. `SCHEMA_MIN` is the newest contract
migration, or the first migration when there is none.
