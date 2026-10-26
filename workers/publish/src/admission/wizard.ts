import { webUploadGate } from "@packserver/core/publishing";
import { WizardUploadRequest } from "@packserver/schema";
import { refusal } from "@packserver/http";
import { Hono } from "hono";
import type { PublishRuntime } from "../bindings";
import { milestonesOf, runById, runView } from "../runs/store";
import { badRequest, readJson } from "../respond";
import { issueCredential, type CredentialRow } from "../upload/credentials";
import { versionTaken } from "./admit";
import { startRun } from "./start";

const MAX_BODY_BYTES = 8 * 1024;

const WRITER_ROLES = ["owner", "maintainer"];

const notFound = () => new Response(JSON.stringify({ error: "not-found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });

interface Standing {
  scope: { id: string; name: string };
  visibility: "public" | "private" | null;
  member: boolean;
}

/** Where a person stands with a pack's scope: the scope, whether the pack is private, and whether they may publish there. */
async function standing(runtime: PublishRuntime, principalId: string, pack: string): Promise<Standing | null> {
  const { d1 } = runtime.ports;
  const [scopeName, packName] = pack.slice(1).split("/") as [string, string];
  const scope = (await d1.query(`select id, name from scopes where name = ?`, [scopeName])).rows[0] as { id: string; name: string } | undefined;
  if (!scope) return null;
  const role = (await d1.query(`select role from scope_members where scope_id = ? and user_id = ?`, [scope.id, principalId])).rows[0] as { role: string } | undefined;
  const found = (await d1.query(`select visibility from packs where scope_id = ? and name = ?`, [scope.id, packName])).rows[0] as { visibility: "public" | "private" } | undefined;
  return { scope, visibility: found?.visibility ?? null, member: role !== undefined && WRITER_ROLES.includes(role.role) };
}

/**
 * What `web` asks of `publish` for a signed-in person. No public route reaches `/internal`;
 * `web` has already authenticated the person and names them by `principal_id`, which is why every
 * call here still checks that person's standing in the pack's scope.
 */
export function wizardRoutes(runtime: PublishRuntime): Hono {
  const app = new Hono();
  const { d1 } = runtime.ports;

  app.post("/wizard", async (c) => {
    const body = await readJson(c.req.raw, MAX_BODY_BYTES);
    const parsed = body.ok ? WizardUploadRequest.safeParse(body.value) : null;
    if (!parsed?.success) return badRequest("expected { pack, version, action, principal_id }");
    const request = parsed.data;

    const where = await standing(runtime, request.principal_id, request.pack);
    if (!where) return notFound();
    if (!where.member) {
      return where.visibility === "public" ? refusal("forbidden", { message: "you cannot publish to this scope" }) : notFound();
    }
    const [, packName] = request.pack.slice(1).split("/") as [string, string];
    const dryRun = request.action === "dry-run" || request.dry_run === true;

    if (request.action === "upload-url") {
      const gate = await webUploadGate(runtime.ports, where.scope.id, packName);
      if (!gate.ok) return refusal(gate.reason === "trusted-only" ? "trusted-only" : "forbidden", { message: gate.message });
      if (!dryRun) {
        if (await versionTaken(d1, where.scope, packName, request.version, runtime.ports.clock.now())) return refusal("exists", { message: `${request.pack}@${request.version} already exists` });
      }
      const issued = await issueCredential(runtime.ports, {
        source: "upload",
        scope: where.scope,
        packName,
        version: request.version,
        lifetime: dryRun ? "dry-run" : "draft",
        userId: request.principal_id,
      });
      const presignPath = `/api/publish/${request.pack}/${request.version}/upload-url`;
      return Response.json(
        { ok: true, upload_url: new URL(presignPath, c.req.url).toString(), presign_path: presignPath, expires_at: issued.expiresAt, credential: issued.secret, credential_id: issued.id },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (request.declared_sha256 === undefined) return badRequest("declared_sha256 is required to start");
    const lifetime = request.action === "dry-run" ? "dry-run" : "draft";
    const staged = (
      await d1.query(
        `select c.id, c.source, c.scope_id, s.name as scope, c.pack_name, c.version, c.user_id, c.trusted_publisher_id, c.staging_key, c.lifetime, c.expires_at, c.used_at, c.uploaded_at, c.size_bytes
         from upload_credentials c join scopes s on s.id = c.scope_id
         where c.user_id = ? and c.scope_id = ? and c.pack_name = ? and c.version = ? and c.lifetime = ? and c.uploaded_at is not null
           and (c.id = ? or (? is null and not exists (select 1 from validation_runs r where r.credential_id = c.id)))
         order by c.issued_at desc, c.id desc limit 1`,
        [request.principal_id, where.scope.id, packName, request.version, lifetime, request.credential_id ?? null, request.credential_id ?? null],
      )
    ).rows[0] as unknown as CredentialRow | undefined;
    if (!staged) return new Response(JSON.stringify({ error: "missing", message: "no confirmed upload is waiting to be started" }), { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    return startRun(runtime, {
      credential: staged,
      kind: request.action === "dry-run" ? "dry-run" : "publish",
      declaredSha256: request.declared_sha256,
      proseScreen: request.prose_screen ?? false,
    });
  });

  /** A signed-in person's view of a run in a scope they publish to. */
  app.get("/runs/:id", async (c) => {
    const principal = c.req.query("principal_id");
    const run = await runById(d1, c.req.param("id"));
    if (!principal || !run) return notFound();
    const member = (await d1.query(`select role from scope_members where scope_id = ? and user_id = ?`, [run.scope_id, principal])).rows[0] as { role: string } | undefined;
    if (!member || !WRITER_ROLES.includes(member.role)) return notFound();
    return Response.json(runView(run, await milestonesOf(d1, run.id), runtime.ports.clock.now()), { headers: { "cache-control": "no-store" } });
  });

  return app;
}
