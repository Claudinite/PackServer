# Spike results (2026-10-21, local `wrangler dev`)

Environment: node v22.22.0, npm 10.9.4, wrangler 4.151.3, agents 0.23.0,
@modelcontextprotocol/server 2.0.0. All commands run from `spike/mcp-worker/`. The sample pack values in the
outputs below (versions, content counts, repo URLs, R2 keys) were later updated to match the current
`seed.sql`, which uses Claudinite pack versions (`1.YMMDD.n`, semver with a date as the minor) and contents; the shape of each response is as captured.

## 1. Install + typecheck

```
$ npm install
added 205 packages, and audited 206 packages in 20s
4 high severity vulnerabilities      # see "Red flags" below
$ npx tsc --noEmit                   # clean, no output
```

## 2. D1 migration (FTS5 + triggers) and seed

```
$ npx wrangler d1 migrations apply packserver --local
🌀 Executing on local database packserver (00000000-...) from .wrangler/state/v3/d1:
🚣 7 commands executed successfully.
┌───────────────┬────────┐
│ name          │ status │
├───────────────┼────────┤
│ 0001_init.sql │ ✅     │
└───────────────┴────────┘

$ npx wrangler d1 execute packserver --local --file=./seed.sql
{ "results": [], "success": true, "meta": { "duration": 0 } }

$ npx wrangler d1 execute packserver --local --command "SELECT count(*) n FROM packs"
"n": 5

$ npx wrangler d1 execute packserver --local --command \
  "SELECT p.name, bm25(packs_fts) r FROM packs_fts JOIN packs p ON p.id=packs_fts.rowid WHERE packs_fts MATCH '\"postg\"*' ORDER BY r"
[{ "name": "@acme/postgres-tuning", "r": -1.6... }]     # FTS5 prefix match works in local D1
```

## 3. MCP over HTTP (`wrangler dev`, port 8787)

```
$ curl -s localhost:8787/health
{"ok":true,"mcp":"/mcp"}
```

### initialize

```
$ curl -s -i localhost:8787/mcp -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
HTTP/1.1 200 OK
Content-Type: text/event-stream
Access-Control-Allow-Origin: *
access-control-allow-headers: Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name
access-control-allow-methods: GET, POST, DELETE, OPTIONS

event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"packserver","version":"0.0.1"}},"jsonrpc":"2.0","id":1}
```

(No `mcp-session-id` header is issued: the handler is stateless; `GET /mcp` returns `405`.)

### tools/list

```
data: {"result":{"tools":[
  {"name":"list_categories","description":"List pack categories with the number of public packs in each.",
   "inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","properties":{}}},
  {"name":"search_packs","description":"Full-text search over public packs by name, summary, description and keywords. Optionally filter by category.",
   "inputSchema":{"type":"object","properties":{"query":{"type":"string","minLength":1,...},"category":{"type":"string",...},"limit":{"default":10,"type":"integer","minimum":1,"maximum":50}},"required":["query"]}},
  {"name":"get_pack","description":"Get full metadata and the download URL for one pack by exact name.",
   "inputSchema":{"type":"object","properties":{"name":{"type":"string","minLength":1,...}},"required":["name"]}}
]},"jsonrpc":"2.0","id":2}
```

### tools/call search_packs {"query":"gcp iam"}

```
data: {"result":{"content":[{"type":"text","text":"[
  { \"name\": \"@google/gcp-basics\", \"version\": \"1.61021.1\", \"category\": \"cloud\",
    \"summary\": \"Work with Google Cloud: projects, IAM, Cloud Run, GKE and BigQuery.\",
    \"stars\": 412, \"rank\": -2.8500607296107665 } ]"}]},"jsonrpc":"2.0","id":3}
```

### tools/call search_packs {"query":"cloud","category":"serverless"}

```
[ { "name": "@cloudflare/workers-kit", "version": "1.61002.3", "category": "serverless",
    "summary": "Build and ship Cloudflare Workers with D1, R2, KV, Queues and Durable Objects.",
    "stars": 289, "rank": -0.00000205524861878453 } ]
```

### tools/call get_pack {"name":"@google/gcp-basics"}

```
{
  "name": "@google/gcp-basics", "version": "1.61021.1", "category": "cloud",
  "summary": "Work with Google Cloud: projects, IAM, Cloud Run, GKE and BigQuery.",
  "description": "Skills and checks for provisioning and operating GCP resources with gcloud and Terraform, with checks for IAM least privilege.",
  "keywords": ["gcp","google","cloud","gcloud","iam","cloud-run","gke","bigquery","terraform"],
  "features": { "rules": 1, "skills": 12, "declaredChecks": 4, "codedChecks": 2, "guards": 1, "tasks": 3 },
  "repo_url": "https://github.com/google/gcp-pack",
  "stars": 412, "visibility": "public", "created_at": "2026-10-21T15:25:41.608Z",
  "download_url": "https://packs.example.dev/@google/gcp-basics/1.61021.1/pack.tar.zst"
}
```

### tools/call get_pack {"name":"@nope/x"}  (not found)

```
data: {"result":{"content":[{"type":"text","text":"Pack not found: @nope/x"}],"isError":true},"jsonrpc":"2.0","id":6}
```

### tools/call list_categories

```
[ {"category":"cloud","count":2}, {"category":"data","count":1},
  {"category":"security","count":1}, {"category":"serverless","count":1} ]
```

### Validation / robustness probes

```
# limit=999 -> zod schema rejects, surfaced as a tool error, not a 500:
"Input validation error: Invalid arguments for tool search_packs: limit: Too big: expected number to be <=50"

# query = 'aws OR (NOT " -x' -> terms are quoted + prefixed before MATCH, no SQLITE_ERROR, returns []

# Accept: application/json only (or no Accept) ->
HTTP/1.1 406 Not Acceptable
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}

# Latency, search_packs x5 against local miniflare+D1: 0.013-0.016 s per call
```

## Red flags / notes

1. **`npm audit`: 4 high** in `@modelcontextprotocol/server 2.0.0-2.2.0`, `@modelcontextprotocol/client`,
   and the transitive `@modelcontextprotocol/sdk <=1.31.0`. `agents@0.23.0` pins the peer dep to
   exactly `@modelcontextprotocol/server@2.0.0`, so we cannot bump to 2.3.1 without an `agents`
   release that allows it. Track before any public deployment.
2. **`responseMode: "json"` did not produce `application/json`**; responses still came back as
   `text/event-stream` (single `event: message` frame). Harmless for MCP clients (they must accept
   both) but worth re-checking against the `agents` changelog; it also means every client MUST send
   `Accept: application/json, text/event-stream` or get a 406.
3. **Env/bindings in tools**: `createMcpHandler`'s factory context does not expose `env`, so the
   handler is built per request inside `fetch` and `createServer(env)` closes over the bindings. The
   docs recommend a module-scope handler only when you need `notify`/`subscriptions`, which we don't.
4. **FTS5 in local D1 works** including external-content tables, `bm25()` with column weights, the
   porter tokenizer, and the `'delete'` command via triggers. Cloudflare's SQL docs list FTS5 as
   supported remotely too, but remote was not exercised here (no account in the sandbox).
5. Wrangler printed proxy-related warnings in this sandbox (`Unable to fetch the Request.cf object`,
   `Request was cancelled`): these come from the outbound proxy and do not affect the Worker.
6. Not covered by the spike: auth (OAuth in front of `/mcp`), rate limiting, private packs, actual
   R2 object serving. All are additive to this shape.
