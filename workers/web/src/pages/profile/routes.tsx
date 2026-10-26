import { loadProfile } from "@packserver/core/scopes";
import { PublisherMark, type PublisherProof } from "@packserver/ui";
import { Hono } from "hono";
import { runtimeOf, type WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { notFoundPage } from "../home/not-found";

export const routes = new Hono<WebEnv>();

/** Hono cannot match a literal `@` before a parameter, so the first path segment is checked here. */
routes.get("/:handle", async (c, next) => {
  const handle = c.req.param("handle");
  if (!handle.startsWith("@")) return next();
  const d1 = runtimeOf(c).ports.d1;
  const profile = await loadProfile(d1, handle.slice(1));
  if (!profile) return notFoundPage(c);
  const { rows } = await d1.query("select name, pitch, has_repository from pack_search where name >= ? and name < ? order by name", [`@${profile.name}/`, `@${profile.name}0`]);
  const listed = new Map(rows.map((r) => [String(r.name), r]));
  const proofs: PublisherProof[] = [
    ...(profile.verified_domain ? [{ kind: "domain" as const, label: profile.verified_domain }] : []),
    ...(profile.verified_github_org ? [{ kind: "github" as const, label: `github.com/${profile.verified_github_org}` }] : []),
  ];
  return renderPage(c, {
    title: `@${profile.name} · Claudinite Packs`,
    children: (
      <>
        <h1 class="mono">@{profile.name}</h1>
        <div class="row mt2">
          <PublisherMark proof={proofs[0]} proofs={proofs} verifiedPublisher={profile.verified_publisher} packCount={profile.packs.length} />
          {profile.verified_publisher ? <span>Verified Publisher</span> : null}
        </div>
        {proofs.length > 1 ? (
          <ul class="tools">{proofs.map((p) => <li class="mono small">● {p.label}</li>)}</ul>
        ) : null}
        <section class="section">
          <h2>Packs</h2>
          {profile.packs.length === 0 ? (
            <p class="empty">No public packs yet.</p>
          ) : (
            <ol class="cards">
              {profile.packs.map((id) => {
                const row = listed.get(id);
                return (
                  <li class="card">
                    <div class="top"><a class="pk mono" href={`/packs/${id}`}>{id}</a></div>
                    {row ? <p class="pitch">{String(row.pitch)}</p> : null}
                    {row && !Number(row.has_repository) ? <div class="meta"><span class="muted">No public repo</span></div> : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </>
    ),
  });
});

