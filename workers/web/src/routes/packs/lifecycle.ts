import {
  deleteOffers, deletePack, isModeration, MODERATION_PREFIX, deleteVersion, restorePack, transitionVersion, type DeleteOutcome, type PackToDelete, type TransitionPorts, type VersionOutcome,
} from "@packserver/core/publishing";
import { refusal, requireSession } from "@packserver/http";
import { Hono, type Context } from "hono";
import { recordAudit, runtimeOf, type WebEnv } from "../../context";
import { notFound, ok, sensitive, signedInPost, standing } from "../scopes/guard";

export const routes = new Hono<WebEnv>();

const MAX_REASON = 1000;

const scopeOf = (c: Context<WebEnv>): string => (c.req.param("scope") ?? "").replace(/^@/, "");

/** The target an assertion for this pack is made for: the pack's name without its `@`. */
const packTarget = (c: Context<WebEnv>): string => `${scopeOf(c)}/${c.req.param("name")}`;
const versionTarget = (c: Context<WebEnv>): string => `${packTarget(c)}@${c.req.param("version")}`;

/** What a body names, read from a copy so the handler still finds the body unread. */
async function bodyOf(c: Context<WebEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.raw.clone().json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** The reason a version is withdrawn for, which the signed index shows to everyone. */
async function reasonOf(c: Context<WebEnv>): Promise<string | Response> {
  const reason = (await bodyOf(c)).reason;
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON) {
    return refusal("forbidden", { status: 422, message: `reason: say why, in up to ${MAX_REASON} characters; it is shown publicly.` });
  }
  if (isModeration(reason.trim())) {
    return refusal("forbidden", { status: 422, message: `reason: it cannot start "${MODERATION_PREFIX}", which is PackServer's own notice.` });
  }
  return reason.trim();
}

function transitionPorts(c: Context<WebEnv>): TransitionPorts {
  const { d1, clock, queues } = runtimeOf(c).ports;
  const reindex = queues.REINDEX_QUEUE;
  if (!reindex) throw new Error("the reindex queue is not bound");
  return { d1, clock, reindex };
}

/** The pack and the caller's standing on its scope; a person with none is told the pack does not exist. */
async function packFor(c: Context<WebEnv>, need: "maintainer" | "owner"): Promise<{ pack: PackToDelete; role: "owner" | "maintainer" } | Response> {
  const scope = scopeOf(c);
  const who = await standing(c, { scope, need: "maintainer", resource: "private" });
  if (who instanceof Response) return who;
  const row = (
    await runtimeOf(c).ports.d1.query(
      "select p.id, p.visibility, p.removed_at, s.id as scope_id from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?",
      [scope, c.req.param("name") ?? ""],
    )
  ).rows[0];
  if (!row) return notFound();
  if (need === "owner" && who.role !== "owner") return refusal("forbidden", { message: "Only an owner can do this." });
  return {
    role: who.role,
    pack: {
      id: String(row.id),
      scope,
      scopeId: String(row.scope_id),
      name: c.req.param("name") ?? "",
      visibility: row.visibility === "private" ? "private" : "public",
      removedAt: row.removed_at === null ? null : String(row.removed_at),
    },
  };
}

const userId = (c: Context<WebEnv>): string => c.get("session")!.record.user_id;

function transitionRefusal(result: Extract<VersionOutcome, { ok: false }>): Response {
  if (result.reason === "unknown_version") return notFound();
  return refusal("forbidden", { status: 409, message: result.message });
}

function deleteRefusal(result: Extract<DeleteOutcome, { ok: false }>): Response {
  return result.reason === "unknown_version" ? notFound() : refusal("forbidden", { status: 409, message: result.message });
}

const named = (c: Context<WebEnv>): string => `@${scopeOf(c)}/${c.req.param("name")}`;

async function withdraw(c: Context<WebEnv>, transition: "deprecate" | "yank"): Promise<Response> {
  const found = await packFor(c, "maintainer");
  if (found instanceof Response) return found;
  const reason = await reasonOf(c);
  if (reason instanceof Response) return reason;
  const security = transition === "yank" && (await bodyOf(c)).security === true;
  const version = c.req.param("version") ?? "";
  const result = await transitionVersion(transitionPorts(c), transition, {
    pack: named(c), version, reason, by: "publisher", ...(security ? { security: reason } : {}),
  });
  if (!result.ok) return transitionRefusal(result);
  if (result.changed) {
    await recordAudit(
      c, userId(c), transition === "yank" ? "version.yanked" : "version.deprecated", `${named(c)}@${version}`,
      transition === "yank" ? { version, reason, security } : { version, reason }, found.pack.scopeId,
    );
  }
  return ok(c, { status: transition === "yank" ? "yanked" : "deprecated", reason, changed: result.changed });
}

/** A maintainer deprecates a version with a public reason; it stays fetchable by exact version (REQ-PUB-023). */
routes.post("/packs/:scope/:name/versions/:version/deprecate", sensitive("version.deprecate", versionTarget), (c) => withdraw(c, "deprecate"));

/** A maintainer yanks a version with a public reason and an optional security flag (REQ-MOD-011). */
routes.post("/packs/:scope/:name/versions/:version/yank", sensitive("version.yank", async (c) => `${versionTarget(c)}:${(await bodyOf(c)).security === true ? "security" : "plain"}`), (c) => withdraw(c, "yank"));

/** Only an owner lifts a yank, and it is audited (REQ-MOD-011). */
routes.post("/packs/:scope/:name/versions/:version/unyank", sensitive("version.unyank", versionTarget), async (c) => {
  const found = await packFor(c, "owner");
  if (found instanceof Response) return found;
  const version = c.req.param("version") ?? "";
  const result = await transitionVersion(transitionPorts(c), "unyank", { pack: named(c), version, reason: null, by: "publisher" });
  if (!result.ok) return transitionRefusal(result);
  if (result.changed) await recordAudit(c, userId(c), "version.unyanked", `${named(c)}@${version}`, { version }, found.pack.scopeId);
  return ok(c, { status: "active", changed: result.changed });
});

/** An owner hard-deletes a version that is under 72 hours old and has never been fetched (REQ-PUB-024). */
routes.post("/packs/:scope/:name/versions/:version/delete", sensitive("version.delete", versionTarget), async (c) => {
  const found = await packFor(c, "owner");
  if (found instanceof Response) return found;
  const version = c.req.param("version") ?? "";
  const result = await deleteVersion(transitionPorts(c), { pack: named(c), version });
  if (!result.ok) return deleteRefusal(result);
  await recordAudit(c, userId(c), "version.deleted", `${named(c)}@${version}`, { version }, found.pack.scopeId);
  return ok(c, { status: "removed" });
});

/** An owner deletes a pack: a public one when every version could be hard-deleted, a private one at any time and restorably (REQ-PUB-025). */
routes.post("/packs/:scope/:name/delete", sensitive("pack.delete", packTarget), async (c) => {
  const found = await packFor(c, "owner");
  if (found instanceof Response) return found;
  const result = await deletePack(transitionPorts(c), found.pack);
  if (!result.ok) return deleteRefusal(result);
  await recordAudit(c, userId(c), "pack.deleted", named(c), undefined, found.pack.scopeId);
  return ok(c, { deleted: true, restorable: found.pack.visibility === "private" });
});

routes.post("/packs/:scope/:name/restore", sensitive("pack.restore", packTarget), async (c) => {
  const found = await packFor(c, "owner");
  if (found instanceof Response) return found;
  const result = await restorePack(transitionPorts(c), found.pack);
  if (!result.ok) return result.reason === "gone" ? refusal("forbidden", { status: 410, message: result.message }) : notFound();
  await recordAudit(c, userId(c), "pack.restored", named(c), undefined, found.pack.scopeId);
  return ok(c, { restored: true });
});

/** What the owner's lifecycle controls offer: each version's status and whether delete is offered, and the pack's own delete state. */
routes.get("/packs/:scope/:name/lifecycle", requireSession<WebEnv>(), async (c) => {
  const found = await packFor(c, "maintainer");
  if (found instanceof Response) return found;
  const { d1, clock } = runtimeOf(c).ports;
  const { pack } = found;
  const statuses = (await d1.query("select version, state from pack_versions where pack_id = ? and state not in ('pending', 'approved') order by version", [pack.id])).rows;
  const offers = pack.visibility === "public" && found.role === "owner" ? new Map((await deleteOffers(d1, clock, pack.id)).map((o) => [o.version, o])) : new Map();
  return ok(c, {
    pack: named(c),
    visibility: pack.visibility,
    deleted: pack.removedAt !== null,
    versions: statuses.map((r) => ({
      version: String(r.version),
      status: String(r.state),
      delete: offers.get(String(r.version)) ?? { deletable: false },
    })),
  });
});

/** The account page's one switch for the stargazer digest (REQ-MOD-013). */
routes.get("/account/star-digest", requireSession<WebEnv>(), async (c) => {
  const row = (await runtimeOf(c).ports.d1.query("select 1 from star_digest_optins where user_id = ?", [userId(c)])).rows[0];
  return ok(c, { on: row !== undefined });
});

routes.put("/account/star-digest", signedInPost(), async (c) => {
  const body = await bodyOf(c);
  if (typeof body.on !== "boolean") return refusal("forbidden", { status: 422, message: "on: true or false." });
  const { d1, clock } = runtimeOf(c).ports;
  await (body.on
    ? d1.query("insert or ignore into star_digest_optins (user_id, created_at) values (?, ?)", [userId(c), new Date(clock.now()).toISOString()])
    : d1.query("delete from star_digest_optins where user_id = ?", [userId(c)]));
  return ok(c, { on: body.on });
});
