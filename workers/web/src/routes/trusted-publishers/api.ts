import { sendNotice } from "@packserver/core/mail";
import {
  changePublisher, listPublishers, ownerAddresses, registerPublisher, setTrustedOnly, webUploadGate, type PublisherInput, type PublisherView,
} from "@packserver/core/publishing";
import { HELD_ACTION_NAMES } from "@packserver/core/identity";
import { loadScope } from "@packserver/core/scopes";
import { refusal } from "@packserver/http";
import { PackName } from "@packserver/schema";
import { Hono, type Context } from "hono";
import { recordAudit, runtimeOf, type WebEnv } from "../../context";
import { notFound, ok, scopePorts, sensitive, signedInPost, standing } from "../scopes/guard";

export const routes = new Hono<WebEnv>();

const badRequest = (message: string) => refusal("forbidden", { status: 400, message });

const scopeOf = (c: Context<WebEnv>): string => (c.req.param("scope") ?? "").replace(/^@/, "");
const packOf = (c: Context<WebEnv>): string => c.req.param("name") ?? "";
/** What an assertion for a registration change is bound to: the pack, not the registration. */
const targetOf = (c: Context<WebEnv>): string => `${scopeOf(c)}/${packOf(c)}`;

async function jsonBody(c: Context<WebEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

const FIELDS = ["repository", "repository_id", "repository_owner_id", "workflow", "environment", "path", "refs", "events", "default_branch"] as const;

/** Only the fields of a registration, with the types they must have; the rest of the body is ignored. */
function inputFrom(body: Record<string, unknown>): Partial<PublisherInput> | string {
  const out: Record<string, unknown> = {};
  for (const key of FIELDS) {
    const value = body[key];
    if (value === undefined) continue;
    const list = key === "refs" || key === "events";
    const okType = list ? Array.isArray(value) && value.every((v) => typeof v === "string") : key === "environment" ? value === null || typeof value === "string" : typeof value === "string";
    if (!okType) return `${key}: wrong type.`;
    out[key] = value;
  }
  return out as Partial<PublisherInput>;
}

const REQUIRED = ["repository", "repository_id", "repository_owner_id", "workflow", "path"] as const;

/** The scope and pack a request names, when the name is well formed and the scope exists. */
async function target(c: Context<WebEnv>) {
  if (!PackName.safeParse(`@${scopeOf(c)}/${packOf(c)}`).success) return null;
  const scope = await loadScope(runtimeOf(c).ports.d1, scopeOf(c));
  if (!scope) return null;
  const { rows } = await runtimeOf(c).ports.d1.query("select visibility from packs where scope_id = ? and name = ?", [scope.id, packOf(c)]);
  return { scope, packName: packOf(c), visibility: rows[0]?.visibility === "private" ? ("private" as const) : ("public" as const) };
}

const fieldsOf = (p: PublisherView): Record<string, string> => ({
  repository: p.repository,
  "repository id": p.repository_id,
  "repository owner id": p.repository_owner_id,
  workflow: p.workflow,
  environment: p.environment ?? "none",
  path: p.path,
  refs: p.refs.join(", "),
  events: p.events.join(", "),
});

/** What the owners are told: every field of a new registration, or each field that changed as before to after. */
function describe(after: PublisherView, before?: PublisherView): string {
  const now = fieldsOf(after);
  if (!before) return Object.entries(now).map(([k, v]) => `${k} ${v}`).join("; ");
  const was = fieldsOf(before);
  const moved = Object.keys(now).filter((k) => now[k] !== was[k]).map((k) => `${k} ${was[k]} -> ${now[k]}`);
  return `${after.repository}: ${moved.length > 0 ? moved.join("; ") : "no field changed"}`;
}

/** Every owner hears of a change to who may publish the pack (REQ-PUB-002). */
async function tellOwners(c: Context<WebEnv>, scopeId: string, change: "added" | "changed", pack: string, what: string): Promise<void> {
  const runtime = runtimeOf(c);
  const { rows } = await runtime.ports.d1.query("select handle from users where id = ?", [c.get("session")!.record.user_id]);
  const host = new URL(runtime.config.siteOrigins[0]).host;
  const data = { pack, change, publisher: what, actor: String(rows[0]?.handle ?? "An owner"), packUrl: `https://${host}/packs/${pack}` };
  for (const address of await ownerAddresses(runtime.ports.d1, scopeId)) await sendNotice(runtime.ports.mail, address, "trusted-publisher-changed", data);
}

/** A pack's registrations; maintainers see them too. */
routes.get("/trusted-publishers/:scope/:name", async (c) => {
  const t = await target(c);
  if (!t) return notFound();
  const who = await standing(c, { scope: t.scope.name, need: "maintainer", resource: t.visibility });
  if (who instanceof Response) return who;
  return ok(c, { publishers: await listPublishers(scopePorts(c), t.scope.id, t.packName) });
});

/** Adds a trusted publisher; for a pack that does not exist yet this reserves the name for 14 days (REQ-PUB-001). */
routes.post("/trusted-publishers/:scope/:name", sensitive(HELD_ACTION_NAMES.trustedPublisherChange, targetOf), async (c) => {
  const t = await target(c);
  if (!t) return notFound();
  const who = await standing(c, { scope: t.scope.name, need: "owner", resource: t.visibility });
  if (who instanceof Response) return who;
  const body = await jsonBody(c);
  const input = inputFrom(body);
  if (typeof input === "string") return badRequest(input);
  const missing = REQUIRED.find((k) => input[k] === undefined);
  if (missing) return badRequest(`${missing}: required.`);
  const userId = c.get("session")!.record.user_id;
  const ports = scopePorts(c);
  const out = await registerPublisher(ports, { scope: t.scope, packName: t.packName, userId, input: input as PublisherInput });
  if (!out.ok) {
    if (out.reason === "invalid") return badRequest(out.message);
    return refusal(out.reason === "cap" ? "quota" : "exists", { status: out.reason === "cap" ? 429 : 409, message: out.message });
  }
  await recordAudit(c, userId, "trusted_publisher.changed", targetOf(c), { change: "added" }, t.scope.id);
  await tellOwners(c, t.scope.id, "added", `@${t.scope.name}/${t.packName}`, describe(out.publisher));
  return ok(c, { publisher: out.publisher }, 201);
});

async function setOnly(c: Context<WebEnv>, on: boolean): Promise<Response> {
  const t = await target(c);
  if (!t) return notFound();
  const who = await standing(c, { scope: t.scope.name, need: "owner", resource: t.visibility });
  if (who instanceof Response) return who;
  if (!(await setTrustedOnly(scopePorts(c), t.scope.id, t.packName, on))) return notFound();
  await recordAudit(c, c.get("session")!.record.user_id, "trusted_publisher.changed", targetOf(c), { change: on ? "trusted-only-on" : "trusted-only-off" }, t.scope.id);
  if (!on) await tellOwners(c, t.scope.id, "changed", `@${t.scope.name}/${t.packName}`, "trusted-publishing-only turned off, so web uploads are allowed again");
  return ok(c, { trusted_only: on });
}

/** Turns trusted-publishing-only on (REQ-PUB-008); tightening needs no assertion. */
routes.put("/trusted-publishers/:scope/:name/only", signedInPost(), (c) => setOnly(c, true));

/** Turning it off loosens who may publish, so it is held and assertion-bound like a registration change. */
routes.delete("/trusted-publishers/:scope/:name/only", sensitive(HELD_ACTION_NAMES.trustedPublisherChange, targetOf), (c) => setOnly(c, false));

/** Changes one registration. */
routes.put("/trusted-publishers/:scope/:name/:id", sensitive(HELD_ACTION_NAMES.trustedPublisherChange, targetOf), async (c) => {
  const t = await target(c);
  if (!t) return notFound();
  const who = await standing(c, { scope: t.scope.name, need: "owner", resource: t.visibility });
  if (who instanceof Response) return who;
  const input = inputFrom(await jsonBody(c));
  if (typeof input === "string") return badRequest(input);
  const userId = c.get("session")!.record.user_id;
  const out = await changePublisher(scopePorts(c), { scope: t.scope, packName: t.packName, userId, id: c.req.param("id") ?? "", patch: input });
  if (!out.ok) return out.reason === "not-found" ? notFound() : badRequest(out.message);
  await recordAudit(c, userId, "trusted_publisher.changed", targetOf(c), { change: "changed" }, t.scope.id);
  await tellOwners(c, t.scope.id, "changed", `@${t.scope.name}/${t.packName}`, describe(out.publisher, out.before));
  return ok(c, { publisher: out.publisher });
});

/** Whether the signed-in person may start a web upload for this pack name; the admission step asks the same question. */
routes.post("/trusted-publishers/:scope/:name/web-upload", signedInPost(), async (c) => {
  const t = await target(c);
  if (!t) return notFound();
  const who = await standing(c, { scope: t.scope.name, need: "maintainer", resource: t.visibility });
  if (who instanceof Response) return who;
  const gate = await webUploadGate(scopePorts(c), t.scope.id, t.packName);
  if (gate.ok) return ok(c, { allowed: true });
  return refusal(gate.reason === "trusted-only" ? "trusted-only" : "forbidden", { message: gate.message });
});
