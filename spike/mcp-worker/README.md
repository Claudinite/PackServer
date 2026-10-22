# PackServer MCP spike (Cloudflare Workers)

Small spike proving a **stateless remote MCP server** on Cloudflare Workers, backed by
**D1 + FTS5** for pack search and an **R2** binding for pack downloads. No Durable Objects.

Stack (pinned in `package.json`):

- `agents@0.23.0` — `createMcpHandler` from `agents/mcp/server` (Cloudflare's recommended
  stateless Streamable HTTP handler, see
  https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- `@modelcontextprotocol/server@2.0.0` — MCP SDK v2 server package (exact peer of `agents`)
- `zod@4.6.7`, `wrangler@4.151.3`

Tools exposed at `POST /mcp`:

| tool              | input                              | backing SQL                                  |
| ----------------- | ---------------------------------- | -------------------------------------------- |
| `list_categories` | `{}`                               | `GROUP BY category` on `packs`               |
| `search_packs`    | `{query, category?, limit?}`       | `packs_fts MATCH ?` + `bm25()` rank          |
| `get_pack`        | `{name}`                           | `SELECT * FROM packs WHERE name = ?`         |

`get_pack` returns metadata plus `download_url = PACKS_PUBLIC_BASE_URL + "/" + r2_key`,
i.e. a path on the R2-served public host. The object does not need to exist for the spike.
The real consumer of that URL is `cn` (through `cn adopt` or the scheduled update), which also
needs the signed per-pack index (`packs/<id>/index.json` and its signature) beside the archive; an
agent finds the pack here and then adopts it with `cn`, never downloading the archive itself.

## Run locally

```bash
cd spike/mcp-worker
npm install
npm run db:migrate      # wrangler d1 migrations apply packserver --local  (creates FTS5 table + triggers)
npm run db:seed         # wrangler d1 execute packserver --local --file=./seed.sql  (5 packs)
npm run dev             # wrangler dev  -> http://localhost:8787
```

Exercise it with raw JSON-RPC (note: the handler **requires** an `Accept` header that lists
both `application/json` and `text/event-stream`, otherwise it answers `406`):

```bash
H1='content-type: application/json'
H2='accept: application/json, text/event-stream'

curl -s localhost:8787/mcp -H "$H1" -H "$H2" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s localhost:8787/mcp -H "$H1" -H "$H2" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s localhost:8787/mcp -H "$H1" -H "$H2" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_packs","arguments":{"query":"gcp iam"}}}'
curl -s localhost:8787/mcp -H "$H1" -H "$H2" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_pack","arguments":{"name":"@google/gcp-basics"}}}'
```

Actual captured output lives in [RESULTS.md](./RESULTS.md).

## Deploying (not done in the spike)

1. `wrangler d1 create packserver` and paste the id into `wrangler.jsonc`.
2. `wrangler r2 bucket create packserver-packs`; attach a custom domain / public access and set
   `PACKS_PUBLIC_BASE_URL`.
3. `wrangler d1 migrations apply packserver --remote && wrangler deploy`.
4. Put auth in front: the same `createMcpHandler(...)` can be passed as `apiHandler` to
   `@cloudflare/workers-oauth-provider` on `apiRoute: "/mcp"`.

## Layout

```
src/index.ts            Worker: createMcpHandler + 3 tools over D1/R2 bindings
migrations/0001_init.sql packs table, packs_fts (FTS5 external-content) + sync triggers
seed.sql                5 sample packs
wrangler.jsonc          D1 (DB) + R2 (PACKS) bindings, PACKS_PUBLIC_BASE_URL var
```
