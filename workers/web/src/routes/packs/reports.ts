import {
  advisoriesFor, fileReport, findPublicPack, IssueLinkInput, isScopeOwner, linkIssue, listInbox, listIssues, listOwn, loadAttachment, readReport, ReportInput,
  saveAttachment, setSecurityContact, setStatus, similarIssues, standingOn, StatusInput,
  MAX_ATTACHMENT_BYTES, type PackRef, type Principal, type ReportPorts,
} from "@packserver/core/reports";
import { objectKey } from "@packserver/core/catalog";
import { consume, idempotency, rateLimited, refusal, requireSession, sessionCaller, sessionCsrf } from "@packserver/http";
import { Meta } from "@packserver/schema";
import { Hono, type Context } from "hono";
import { runtimeOf, siteOriginOf, type WebEnv } from "../../context";


export const routes = new Hono<WebEnv>();

const NO_STORE = { "cache-control": "no-store" };
/** One limit serves every route, so a filing or an upload costs 6 of its 60 a minute. */
const REPORT_COST = 6;

const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
const invalid = (message: string) => refusal("forbidden", { status: 422, message });

function portsOf(c: Context<WebEnv>): ReportPorts {
  const { ports } = runtimeOf(c);
  return { clock: ports.clock, rng: ports.rng, d1: ports.d1, siteOrigin: siteOriginOf(c) };
}

function principalOf(c: Context<WebEnv>): Principal {
  const session = c.get("session");
  return session ? { kind: "user", id: session.record.user_id } : { kind: "anonymous" };
}

const userId = (c: Context<WebEnv>): string => c.get("session")!.record.user_id;

async function packOf(c: Context<WebEnv>): Promise<PackRef | null> {
  return findPublicPack(runtimeOf(c).ports.d1, c.req.param("scope") ?? "", c.req.param("name") ?? "");
}

async function throttled(c: Context<WebEnv>): Promise<boolean> {
  const { RATE_LIMIT } = runtimeOf(c).ports.rateLimits;
  return !(await consume(RATE_LIMIT!, `report:${userId(c)}`, REPORT_COST));
}

/** The repository whose issues a bug on this version is offered, read from the version's own provenance: only a source the registry verified names one. */
async function linkedRepository(c: Context<WebEnv>, pack: PackRef, version: string): Promise<string | null> {
  const body = await runtimeOf(c).ports.r2.PACKS_PUBLIC?.get(objectKey(pack.name, "meta", version));
  if (!body) return null;
  try {
    const meta = Meta.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return meta.success && meta.data.provenance.source === "oidc" ? meta.data.provenance.repository : null;
  } catch {
    return null;
  }
}

/** Reads at most `cap` bytes; null when the body is longer, without keeping more than the cap in memory. */
async function readCapped(request: Request, cap: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? 0) > cap) return null;
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const csrfGuard = (c: Context<WebEnv>, next: () => Promise<void>) => sessionCsrf<WebEnv>(siteOriginOf)(c, next);
const once = (c: Context<WebEnv>, next: () => Promise<void>) => idempotency({ kv: runtimeOf(c).ports.kv.SESSIONS_KV!, caller: sessionCaller })(c, next);

/** The public Issues tab: bug reports only. */
routes.get("/packs/:scope/:name/issues", async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  return c.json({ issues: await listIssues(portsOf(c), pack) }, 200, NO_STORE);
});

/** What a reporter sees before submitting (REQ-MOD-005). */
routes.get("/packs/:scope/:name/reports/similar", async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const title = (c.req.query("title") ?? "").slice(0, 140);
  return c.json({ similar: await similarIssues(portsOf(c), pack, title) }, 200, NO_STORE);
});

/** The maintainers' inbox, security reports included. */
routes.get("/packs/:scope/:name/reports", requireSession(), async (c) => {
  const pack = await packOf(c);
  const inbox = pack ? await listInbox(portsOf(c), pack, principalOf(c)) : null;
  return inbox ? c.json(inbox, 200, NO_STORE) : notFound();
});

routes.post("/packs/:scope/:name/reports/attachments", requireSession(), csrfGuard, async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  if (await throttled(c)) return rateLimited();
  const bytes = await readCapped(c.req.raw, MAX_ATTACHMENT_BYTES);
  if (bytes === null) return refusal("quota", { status: 413, message: "Attachments can be at most 5 MB." });
  const saved = await saveAttachment(portsOf(c), { user_id: userId(c), name: c.req.query("name") ?? "", bytes });
  if (!saved.ok) return ["too_many", "allowance", "storage_full"].includes(saved.reason) ? refusal("quota", { message: saved.message }) : invalid(saved.message);
  return c.json({ attachment: saved.attachment }, 201, NO_STORE);
});

routes.post("/packs/:scope/:name/reports", requireSession(), csrfGuard, once, async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const parsed = ReportInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(`format: ${parsed.error.issues[0]?.path.join(".") || "report"} is not valid.`);
  if (await throttled(c)) return rateLimited();
  const repository = parsed.data.kind === "bug" ? await linkedRepository(c, pack, parsed.data.version) : null;
  const filed = await fileReport(portsOf(c), pack, userId(c), parsed.data, repository);
  if (!filed.ok) return invalid(filed.message);
  return c.json({ report: filed.report, new_issue_url: filed.new_issue_url }, 201, NO_STORE);
});

routes.get("/reports/:id", async (c) => {
  const report = await readReport(portsOf(c), c.req.param("id"), principalOf(c));
  return report ? c.json({ report }, 200, NO_STORE) : notFound();
});

routes.get("/reports/:id/attachments/:attachment", async (c) => {
  const ports = portsOf(c);
  const stored = await loadAttachment(ports, c.req.param("attachment"));
  // A file is served only through a report the caller may read, and only as the report it is attached to.
  if (!stored || stored.report_id !== c.req.param("id") || !(await readReport(ports, stored.report_id, principalOf(c)))) return notFound();
  const name = stored.name.replace(/[^\x20-\x7e]/g, "_");
  return new Response(stored.bytes, {
    headers: {
      "content-type": stored.content_type,
      "content-disposition": `${stored.disposition}; filename="${name}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});

routes.post("/reports/:id/status", requireSession(), csrfGuard, once, async (c) => {
  const parsed = StatusInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(`format: ${parsed.error.issues[0]?.message ?? "status is not valid."}`);
  const result = await setStatus(portsOf(c), c.req.param("id"), principalOf(c), parsed.data);
  if (result.ok) return c.json({ report: result.report }, 200, NO_STORE);
  if (result.reason === "not_found") return notFound();
  if (result.reason === "forbidden") return refusal("forbidden", { message: result.message ?? "" });
  if (result.reason === "no_change") return c.json({ report: await readReport(portsOf(c), c.req.param("id"), principalOf(c)) }, 200, NO_STORE);
  return invalid(result.message ?? "");
});

/** The reporter names the GitHub issue they opened, so its state can be followed. */
routes.post("/reports/:id/issue", requireSession(), csrfGuard, once, async (c) => {
  const parsed = IssueLinkInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid("format: issue_url is required.");
  const result = await linkIssue(portsOf(c), c.req.param("id"), userId(c), parsed.data.issue_url);
  if (result.ok) return c.json({ report: result.report }, 200, NO_STORE);
  if (result.reason === "not_found") return notFound();
  if (result.reason === "taken") return refusal("exists", { message: result.message ?? "" });
  return result.reason === "forbidden" ? refusal("forbidden", { message: result.message ?? "" }) : invalid(result.message ?? "");
});

/** Everything the signed-in person filed, public and private (REQ-MOD-017). */
routes.get("/account/reports", requireSession(), async (c) => c.json({ reports: await listOwn(portsOf(c), userId(c)) }, 200, NO_STORE));

routes.put("/packs/:scope/:name/security-contact", requireSession(), csrfGuard, once, async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const ports = portsOf(c);
  if (!(await isScopeOwner(ports.d1, pack, userId(c)))) {
    return (await standingOn(ports.d1, pack, principalOf(c))) === "maintainer" ? refusal("forbidden", { message: "Only owners set the security contact." }) : notFound();
  }
  const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
  const email = body?.email;
  if (email !== null && (typeof email !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email))) return invalid("format: email is not valid.");
  await setSecurityContact(ports, pack, email as string | null);
  return c.json({ security_contact: email }, 200, NO_STORE);
});

/** Published advisories, which is all the public ever learns of a security report. */
routes.get("/packs/:scope/:name/advisories", async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  return c.json({ advisories: await advisoriesFor(runtimeOf(c).ports.d1, pack.id, c.req.query("version")) }, 200, { "cache-control": "public, max-age=60" });
});
