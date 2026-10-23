import { Hono } from "hono";
import { clientIp, rateLimit } from "@packserver/http";
import { CACHE_PRIVATE, HASH_VISIBLE_STATES, SHA256_HEX, answerHash } from "@packserver/core/catalog";
import { runtimeOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

const MATCH_LIMIT = 20;

routes.get(
  "/verify/:sha256",
  (c, next) => {
    const limiter = runtimeOf(c).ports.rateLimits.RATE_LIMIT;
    if (!limiter) throw new Error("the RATE_LIMIT binding is missing");
    return rateLimit({ limiter, key: (ctx) => `verify:${clientIp(ctx)}` })(c, next);
  },
  async (c) => {
    const hash = (c.req.param("sha256") ?? "").toLowerCase();
    const headers = { "cache-control": CACHE_PRIVATE };
    if (!SHA256_HEX.test(hash)) return c.json({ error: "not_a_sha256" }, 400, headers);
    // Private packs are filtered in the query, so their hashes take the same path as a random one.
    const { rows } = await runtimeOf(c).ports.d1.query(
      `SELECT s.name AS scope, p.name AS pack, pv.version AS version, pv.state AS state, pv.sha256 AS sha256, pv.upload_sha256 AS upload_sha256 FROM pack_versions pv JOIN packs p ON p.id = pv.pack_id JOIN scopes s ON s.id = p.scope_id WHERE (pv.sha256 = ? OR pv.upload_sha256 = ?) AND p.visibility = 'public' AND pv.state IN (${HASH_VISIBLE_STATES.map(() => "?").join(", ")}) ORDER BY pv.published_at, pv.id LIMIT ?`,
      [hash, hash, ...HASH_VISIBLE_STATES, MATCH_LIMIT],
    );
    const answer = answerHash(
      hash,
      rows.map((r) => ({
        pack: `@${String(r.scope)}/${String(r.pack)}`,
        version: String(r.version),
        state: String(r.state),
        sha256: String(r.sha256),
        upload_sha256: typeof r.upload_sha256 === "string" ? r.upload_sha256 : null,
      })),
    );
    return c.json(answer, 200, headers);
  },
);
