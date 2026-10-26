import { type FetchRecord, mayRead, privateArchiveKey, privateEntryKey, readablePacks, systemName } from "@packserver/core/access";
import { objectResponseHeaders, CACHE_PRIVATE } from "@packserver/core/catalog";
import { sha256Hex } from "@packserver/core/index";
import { PrivateEntry, type PrivateIndexEnvelope } from "@packserver/schema";
import { requestTelemetry } from "@packserver/http";
import { Hono, type Context } from "hono";
import { runtimeOf, type WebEnv } from "../../context";
import { resolveCaller } from "./caller";
import { fetchRecord, principalOf, writeFetches } from "./log";

export const routes = new Hono<WebEnv>();

/**
 * Runs work after the response is on its way, so a request that is refused takes no longer than
 * one for something that does not exist. Without an execution context the work is awaited.
 */
async function afterResponse(c: Context<WebEnv>, work: () => Promise<void>): Promise<void> {
  const run = work().catch((error: unknown) => console.error(JSON.stringify({ event: "private.fetch_log_failed", message: error instanceof Error ? error.message : "unknown" })));
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    await run;
  }
}

const NO_STORE = { "cache-control": CACHE_PRIVATE };
/** The one answer for a pack or version that does not exist and for one the caller may not know exists. */
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
const unavailable = () => Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });

/** Versions the registry will hand out bytes for; an exact fetch of a yanked one is allowed. */
const SERVED = new Set(["active", "deprecated", "yanked"]);
const HELD = new Set(["quarantined", "revoked"]);

/**
 * The validator-signed entries of the private packs the caller may read, as stored. The envelope
 * is unsigned and never storable; this Worker holds no signing key and signs nothing.
 */
routes.get("/private/index", async (c) => {
  const resolved = await resolveCaller(c);
  if ("response" in resolved) return resolved.response;
  const { caller } = resolved;
  const runtime = runtimeOf(c);
  const entries: PrivateEntry[] = [];
  const records: FetchRecord[] = [];
  const named = c.req.query("pack");
  let packs = await readablePacks(runtime.ports.d1, caller);
  if (named !== undefined) {
    // A named pack the caller may not read is answered as one that does not exist.
    packs = packs.filter((p) => systemName(p) === named);
    if (packs.length === 0) return notFound();
  }
  for (const pack of packs) {
    const stored = await runtime.ports.r2.PACKS_PRIVATE?.get(privateEntryKey(pack.id));
    if (!stored) continue;
    let parsed: ReturnType<typeof PrivateEntry.safeParse> | undefined;
    try {
      parsed = PrivateEntry.safeParse(JSON.parse(new TextDecoder().decode(stored)));
    } catch {
      parsed = undefined;
    }
    if (!parsed?.success || parsed.data.pack !== systemName(pack)) {
      requestTelemetry(c).emit("index.entry_skipped", { pack_id: pack.id, reason: parsed === undefined ? "unparsable" : parsed.success ? "wrong_pack" : "invalid" });
      continue;
    }
    entries.push(parsed.data);
    records.push(await fetchRecord(c, caller, pack, { kind: "index", outcome: "served" }));
  }
  await writeFetches(c, records);
  if (named !== undefined && entries.length === 0) return notFound();
  const envelope: PrivateIndexEnvelope = { private: true, storable: false, entries };
  return Response.json(envelope, { headers: NO_STORE });
});

routes.get("/private/v/:versionId", async (c) => {
  const resolved = await resolveCaller(c);
  if ("response" in resolved) return resolved.response;
  const { caller } = resolved;
  const runtime = runtimeOf(c);
  const versionId = c.req.param("versionId");
  const found = await runtime.ports.d1.query(
    `select v.state as state, v.sha256 as sha256, v.version as version, p.id as pack_id, p.name as name, s.name as scope
       from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
      where v.id = ? and p.visibility = 'private'`,
    [versionId],
  );
  const row = found.rows[0];
  if (!row) return notFound();
  const pack = { id: row.pack_id as string, scope: row.scope as string, name: row.name as string };
  if (!(await mayRead(runtime.ports.d1, caller, pack.id))) {
    await afterResponse(c, async () => writeFetches(c, [await fetchRecord(c, caller, pack, { kind: "download", outcome: "denied", versionId })]));
    return notFound();
  }
  const state = row.state as string;
  if (HELD.has(state)) return Response.json({ status: state, under_review: true }, { status: 451, headers: NO_STORE });
  if (state === "removed") return Response.json({ status: "removed" }, { status: 410, headers: NO_STORE });
  if (!SERVED.has(state)) return notFound();

  const bytes = await runtime.ports.r2.PACKS_PRIVATE?.get(privateArchiveKey(versionId));
  if (!bytes) return unavailable();
  if ((await sha256Hex(bytes)) !== row.sha256) {
    requestTelemetry(c).emit("download.hash_mismatch", { version_id: versionId });
    return unavailable();
  }
  await writeFetches(c, [await fetchRecord(c, caller, pack, { kind: "download", outcome: "served", versionId })]);
  requestTelemetry(c).download({
    visibility: "private",
    pack: systemName(pack),
    version: row.version as string,
    versionId,
    fetcher: "cn_update",
    principal: principalOf(caller),
    ...(c.req.header("cf-connecting-ip") === undefined ? {} : { ip: c.req.header("cf-connecting-ip")! }),
    ...(c.req.header("cf-ipcountry") === undefined ? {} : { country: c.req.header("cf-ipcountry")! }),
    userAgent: c.req.header("user-agent") ?? null,
    ...(caller.kind === "oidc" ? { repository: { ownerId: caller.ownerId, name: caller.repository, ...(caller.visibility === undefined ? {} : { visibility: caller.visibility }) } } : {}),
    bytes: bytes.byteLength,
  });
  return new Response(bytes, { headers: { ...objectResponseHeaders("archive", { private: true }), "content-length": String(bytes.byteLength) } });
});
