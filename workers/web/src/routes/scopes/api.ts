import { acceptTransfer, incomingFor, loadProfile, loadScope, movedTo, offerTransfer } from "@packserver/core/scopes";
import { refusal, requireSession } from "@packserver/http";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { notFound, ok, scopePorts, sensitive, standing } from "./guard";

export const routes = new Hono<WebEnv>();

/** The public profile: the proofs, the label, the mark and the public packs (REQ-SCOPE-015). */
routes.get("/scopes/:scope", async (c) => {
  const profile = await loadProfile(c.get("runtime").ports.d1, c.req.param("scope"));
  return profile ? c.json(profile, 200, { "cache-control": "no-cache" }) : notFound();
});

/** Where a pack that changed scope went. A pack that never moved, and a private one the caller cannot read, answer alike. */
routes.get("/scopes/:scope/moved/:pack", async (c) => {
  const to = await movedTo(c.get("runtime").ports.d1, c.req.param("scope"), c.req.param("pack"), c.get("session")?.record.user_id);
  return to ? c.json({ moved_to: to }, 200, { "cache-control": "no-cache" }) : notFound();
});

/** Offers a pack to another scope; nothing moves until that scope's owner accepts (REQ-SCOPE-014). */
routes.post("/scopes/:scope/packs/:pack/transfer", sensitive("pack.transfer"), async (c) => {
  const scopeName = c.req.param("scope");
  const packName = c.req.param("pack");
  const ports = scopePorts(c);
  const scope = await loadScope(ports.d1, scopeName);
  const { rows } = scope ? await ports.d1.query("select id, visibility from packs where scope_id = ? and name = ?", [scope.id, packName]) : { rows: [] };
  const pack = rows[0];
  if (!pack) return notFound();
  const who = await standing(c, { scope: scopeName, need: "owner", resource: pack.visibility === "private" ? "private" : "public" });
  if (who instanceof Response) return who;
  const to = ((await c.req.json().catch(() => null)) as { to?: unknown } | null)?.to;
  if (typeof to !== "string" || to.trim() === "") return refusal("forbidden", { status: 400, message: "to: name the scope to offer the pack to." });
  const offer = await offerTransfer(ports, {
    packId: String(pack.id),
    packName,
    fromScope: scopeName,
    toScope: to.trim().replace(/^@/, ""),
    offeredBy: c.get("session")!.record.user_id,
  });
  if (!offer.ok) return refusal(offer.reason === "unknown_target" ? "forbidden" : "exists", { status: offer.reason === "unknown_target" ? 404 : 409, message: offer.message });
  return ok(c, { transfer: offer.transfer }, 201);
});

/** Offers waiting for this person to accept as an owner of the receiving scope. */
routes.get("/transfers", requireSession(), async (c) => ok(c, { transfers: await incomingFor(scopePorts(c), c.get("session")!.record.user_id) }));

routes.post("/transfers/:id/accept", sensitive("pack.transfer.accept"), async (c) => {
  const result = await acceptTransfer(scopePorts(c), c.get("session")!.record.user_id, c.req.param("id"));
  if (result.ok) return ok(c, { transfer: result.transfer });
  if (result.reason === "not_found") return notFound();
  if (result.reason === "forbidden") return refusal("forbidden", { message: result.message });
  const gone = result.reason === "lapsed" || result.reason === "void";
  return refusal(gone ? "forbidden" : "exists", { status: gone ? 410 : 409, message: result.message });
});
