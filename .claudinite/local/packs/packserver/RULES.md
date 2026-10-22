# packserver

- **Writing code that stores or changes data** (a D1 row, an R2 object, a KV value, a queue
  message, Durable Object state) — the previous release will read it: a release can be rolled
  back at any point after it deploys, automatically during a rollout, so the version before
  yours must handle everything yours writes. Write new shapes additively, never repurpose a
  field. (writing-code-stores)
