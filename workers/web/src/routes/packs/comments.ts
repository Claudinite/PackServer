import { CommentInput, commentCounts, isHeldComment, listComments, postComment, VoteInput, voteOnComment, type CommentRefusal } from "@packserver/core/community";
import { refusal, requireSession } from "@packserver/http";
import { Hono, type Context } from "hono";
import { runtimeOf, type WebEnv } from "../../context";
import { sectionsOf } from "../../pages/pack/sections";
import { isReadable, READABLE, readContents } from "./contents";
import { communityPorts, csrfGuard, notFound, once, packOf, userId } from "./stars";

export const routes = new Hono<WebEnv>();

const NO_STORE = { "cache-control": "no-store" };

function refused(r: CommentRefusal): Response {
  switch (r.reason) {
    case "not_found":
      return notFound();
    case "daily_limit":
      return refusal("quota", { message: r.message });
    default:
      return refusal("forbidden", { message: r.message });
  }
}

const invalid = (what: string) => refusal("forbidden", { status: 422, message: `format: ${what} is not valid.` });

/** Whether `section` is a section of the version's readable files. */
async function sectionExists(c: Context<WebEnv>, pack: { id: string; name: string }, version: string, section: string): Promise<boolean> {
  const state = await runtimeOf(c).ports.d1.query("select state from pack_versions where pack_id = ? and version = ?", [pack.id, version]);
  if (!state.rows[0] || !isReadable(String(state.rows[0].state))) return false;
  const read = await readContents(c, pack.name, version);
  return read.kind === "found" && read.contents.files.some((f) => sectionsOf(f.path, f.text).some((s) => s.id === section));
}

/** The pack comments apply to: public, and with a version a resolver still hands out; a revoked or removed pack answers as absent. */
async function commentPack(c: Context<WebEnv>) {
  const pack = await packOf(c);
  if (!pack) return null;
  const { rows } = await runtimeOf(c).ports.d1.query(`select 1 from pack_versions where pack_id = ? and state in (${READABLE.map(() => "?").join(", ")}) limit 1`, [pack.id, ...READABLE]);
  return rows.length > 0 ? pack : null;
}

/** Comments on one section (`?section=`), or how many each section has when none is named. */
routes.get("/packs/:scope/:name/comments", async (c) => {
  const pack = await commentPack(c);
  if (!pack) return notFound();
  const ports = communityPorts(c);
  const section = c.req.query("section");
  if (section === undefined) return c.json({ counts: await commentCounts(ports, pack) }, 200, NO_STORE);
  return c.json({ comments: await listComments(ports, pack, c.get("session")?.record.user_id, section) }, 200, NO_STORE);
});

routes.post("/packs/:scope/:name/comments", requireSession(), csrfGuard, once, async (c) => {
  const pack = await commentPack(c);
  if (!pack) return notFound();
  const parsed = CommentInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.path.join(".") || "comment");
  if (!(await sectionExists(c, pack, parsed.data.version, parsed.data.section))) return refusal("forbidden", { status: 422, message: "That section does not exist in that version." });
  const result = await postComment(communityPorts(c), pack, userId(c), parsed.data, await isHeldComment(parsed.data.body));
  return result.ok ? c.json({ comment: result.comment }, 201, NO_STORE) : refused(result);
});

routes.put("/packs/:scope/:name/comments/:id/vote", requireSession(), csrfGuard, once, async (c) => {
  const pack = await commentPack(c);
  if (!pack) return notFound();
  const parsed = VoteInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid("value");
  const result = await voteOnComment(communityPorts(c), pack, userId(c), c.req.param("id"), parsed.data.value);
  return result.ok ? c.json({ comment: result.comment }, 200, NO_STORE) : refused(result);
});

routes.delete("/packs/:scope/:name/comments/:id/vote", requireSession(), csrfGuard, once, async (c) => {
  const pack = await commentPack(c);
  if (!pack) return notFound();
  const result = await voteOnComment(communityPorts(c), pack, userId(c), c.req.param("id"), 0);
  return result.ok ? c.json({ comment: result.comment }, 200, NO_STORE) : refused(result);
});
