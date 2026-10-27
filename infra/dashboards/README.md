# Dashboards

The five dashboards of [monitoring.md](../../docs/operations/monitoring.md) (Overview, Release,
Publish pipeline, Trust and abuse, Platform and cost) as code: `dashboards.json` declares each
panel as Analytics Engine SQL.

**No create API.** Cloudflare has no API that creates a dashboard over Analytics Engine datasets.
Its documented ways to see that data are the SQL API and Grafana (Grafana is ruled out by D5); the
Workers Observability Query Builder searches Workers Logs only. So the "apply" step here is
rendering and reading, not creating:

```
node infra/dashboards/apply.mjs                                   # validate offline, no network
node infra/dashboards/apply.mjs --env staging --export out        # out/staging.json, rendered SQL per panel
CLOUDFLARE_ACCOUNT_ID=... ANALYTICS_READ_TOKEN=... \
  node infra/dashboards/apply.mjs --env production --run --dashboard overview
```

`--run` is read only and needs a token with Account | Account Analytics | Read. It prints one
result per panel and exits non-zero if any panel could not be read; a failed read is never shown
as an empty panel.

## What is validated

Without any network, against the source that writes the points: every dataset is one the signals
catalogue lists, every `{{col:dataset.field}}` is a field the writer stores (column numbers come
from the blob and double arrays in the source), every signal named in a panel exists and is read
from the dataset it is written to, every outcome literal is one the recorder emits, and each panel
reads exactly one dataset and bounds its time range.

## Writing a panel

Tokens in `sql`: `{{ds:dataset}}` (adds `_staging` outside production), `{{col:dataset.field}}`,
`{{num:signal.field}}` (a signal's fixed double, from `SIGNAL_NUMBERS`), `{{stat:signal.field}}` (a field of a validator statistic, which has its own layout), `{{bucket:seconds}}`
(time bucket for a series), `{{since}}` (the panel's `range`). Domain-style datasets store the
Worker, release and version in blobs 1 to 3 and the signal's attributes as JSON in blob 4;
attributes are matched with `LIKE '%"key":value%'` because the SQL dialect documents no JSON
functions. Sums weight by `_sample_interval`.

## Click path for a person

1. Use the Account Analytics Read token the judge already binds as `ANALYTICS_READ_TOKEN`
   (created for #158); do not mint a second one.
2. Export the account id from the dashboard's Workers and Pages overview.
3. Run the `--run` command above for the dashboard you want (Overview first); the Release dashboard
   is the one to read during a rollout.
