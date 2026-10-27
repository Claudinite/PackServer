import { RELEASE_HEADER } from "@packserver/schema";
import { BodyTooLarge, readBoundedBody, requireSession } from "@packserver/http";
import { HELD_ACTION_NAMES } from "@packserver/core/identity";
import { Hono, type Context } from "hono";
import { runtimeOf, type WebEnv } from "../../context";
import { notFound, sensitive, signedInPost } from "../../routes/scopes/guard";
import { loadRun, verdictSentence } from "../validation/data";
import { lookupPack, splitPack } from "./data";

export const START_ACTION = HELD_ACTION_NAMES.publishStart;

const NO_STORE = { "cache-control": "no-store" };
const PUBLISH = "http://publish.internal/internal/wizard";
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const api = new Hono<WebEnv>();

interface Asked {
  pack: string;
  version: string;
  sha256?: string;
  credential_id?: string;
  dry_run?: boolean;
  prose_screen?: boolean;
}

const bad = (message: string): Response => Response.json({ error: "bad-request", message }, { status: 400, headers: NO_STORE });

/** The JSON body read through the shared cap; an oversize or unparseable body is null. */
async function boundedJson(c: Context<WebEnv>): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBoundedBody(c)));
  } catch (e) {
    if (e instanceof BodyTooLarge || e instanceof SyntaxError) return null;
    throw e;
  }
}

async function asked(c: Context<WebEnv>, need: { sha: boolean }): Promise<Asked | Response> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.pack !== "string" || typeof body.version !== "string") return bad("expected { pack, version }");
  if (!splitPack(body.pack) || !VERSION.test(body.version)) return bad("A pack is @scope/name and a version is like 1.2.3.");
  const sha = body.sha256;
  if (need.sha && (typeof sha !== "string" || !SHA256.test(sha))) return bad("expected the archive's sha256.");
  const credential = body.credential_id;
  if (credential !== undefined && (typeof credential !== "string" || credential.length === 0)) return bad("credential_id must be a string.");
  return {
    pack: body.pack,
    version: body.version,
    ...(typeof sha === "string" ? { sha256: sha } : {}),
    ...(typeof credential === "string" ? { credential_id: credential } : {}),
    ...(body.dry_run === true ? { dry_run: true } : {}),
    ...(body.prose_screen === true ? { prose_screen: true } : {}),
  };
}

/** What `web` asks of `publish` for a signed-in person; `publish` checks their standing in the pack's scope again. */
async function askPublish(c: Context<WebEnv>, body: Record<string, unknown>): Promise<Response> {
  const runtime = runtimeOf(c);
  const res = await runtime.services.publish.fetch(PUBLISH, {
    method: "POST",
    headers: { "content-type": "application/json", [RELEASE_HEADER]: runtime.version.releaseId },
    body: JSON.stringify({ principal_id: c.get("session")!.record.user_id, ...body }),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", ...NO_STORE } });
}

/** The pack as the wizard needs it: whether it exists (a new pack is the one a price would apply to) and how it is shown. */
api.get("/publish/wizard/pack", requireSession<WebEnv>(), async (c) => {
  const found = await lookupPack(c, c.get("session")!.record.user_id, c.req.query("name") ?? "");
  return found ? c.json({ pack: found.full, exists: found.exists, visibility: found.visibility }, 200, NO_STORE) : notFound();
});

/** A single-use credential for one presigned PUT: the check step's dry-run object, or the draft that outlives it. */
api.post("/publish/wizard/upload", signedInPost(), async (c) => {
  const a = await asked(c, { sha: false });
  if (a instanceof Response) return a;
  return askPublish(c, { pack: a.pack, version: a.version, action: "upload-url", ...(a.dry_run ? { dry_run: true } : {}) });
});

/** The check step: validates the object the dry-run credential staged and creates no version. */
api.post("/publish/wizard/check", signedInPost(), async (c) => {
  const a = await asked(c, { sha: true });
  if (a instanceof Response) return a;
  return askPublish(c, { pack: a.pack, version: a.version, action: "dry-run", declared_sha256: a.sha256, credential_id: a.credential_id, ...(a.prose_screen ? { prose_screen: true } : {}) });
});

/** Publish, confirmed with a passkey assertion made for this pack and version. */
api.post(
  "/publish/wizard/start",
  sensitive(START_ACTION, async (c) => {
    const body = (await boundedJson(c)) as { pack?: unknown; version?: unknown } | null;
    return `${String(body?.pack)}@${String(body?.version)}`;
  }),
  async (c) => {
    const a = await asked(c, { sha: true });
    if (a instanceof Response) return a;
    return askPublish(c, { pack: a.pack, version: a.version, action: "start", declared_sha256: a.sha256, credential_id: a.credential_id });
  },
);

/** One run as the wizard polls it: how far it has got, its verdict in a sentence, and what to fix. */
api.get("/publish/wizard/runs/:id", requireSession<WebEnv>(), async (c) => {
  const run = await loadRun(c, c.req.param("id"));
  if (!run || run.role === null) return notFound();
  return c.json(
    {
      id: run.id,
      kind: run.kind,
      pack: `@${run.scope}/${run.pack}`,
      version: run.version,
      status: run.status,
      verdict: run.verdict,
      sentence: verdictSentence(run),
      approval: run.approval,
      published: run.published,
      milestones: run.milestones.map((m) => ({ step: m.step, outcome: m.outcome })),
      findings: run.findings.map((f) => ({ class: f.class, rule: f.rule, file: f.file ?? null, line: f.line ?? null, hint: f.hint })),
    },
    200,
    NO_STORE,
  );
});
