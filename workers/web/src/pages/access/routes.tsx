import { authorize } from "@packserver/core/scopes";
import { Hono, type Context } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { findPack } from "../../routes/access/store";
import { loadAccess, type AccessView } from "../../routes/access/store";
import { ACCOUNT_CSS, ActionDialog, CLIENT_LIB } from "../account";
import { loadWho } from "../account/data";
import { dateOf, plural, stampOf } from "../account/format";
import { notFoundPage } from "../home/not-found";
import { ACCESS_CLIENT } from "./client";

export const routes = new Hono<WebEnv>();

const NO_STORE = "private, no-store";

const wasAt = (iso: string): number => Date.parse(iso);

function Visibility(props: { view: AccessView; owner: boolean }) {
  const { view } = props;
  const owner = props.owner && !view.published;
  const isPrivate = view.visibility === "private";
  return (
    <section>
      <h2>Visibility</h2>
      <p class="lede">{isPrivate ? "Private. Only the accounts below can read it." : "Public. Anyone can read every version, and it stays that way."}</p>
      {owner && isPrivate ? (
        <form class="form" id="make-public">
          <label class="row">
            <input type="checkbox" name="confirm" required />
            <span>I understand every version becomes public and this cannot be undone.</span>
          </label>
          <div><button class="btn danger" type="submit">Make public</button></div>
        </form>
      ) : null}
      {owner && !isPrivate ? (
        <>
          <p class="muted small mt2">Versions published while the pack was public stay public. Versions published after this change are private.</p>
          <p class="mt2"><button class="btn" type="button" data-do="make-private">Make private</button></p>
        </>
      ) : null}
      {props.owner && view.published ? <p class="muted small mt2">Visibility cannot change once a version is published. Moving published versions between the public and private stores comes later.</p> : null}
      {!props.owner ? <p class="muted small mt2">Only an owner of the scope can change this.</p> : null}
    </section>
  );
}

function Allowlist(props: { view: AccessView }) {
  const { grants } = props.view;
  return (
    <section>
      <h2>Who can read</h2>
      <p class="lede">GitHub accounts, matched by their numeric id. An organisation account covers its repositories.</p>
      {grants.length === 0 ? <p class="muted mt2">No account yet.</p> : (
        <ul class="list">
          {grants.map((g) => (
            <li>
              <span class="grow">
                <code>{g.account_id}</code>{g.private_repos_only ? " · private repositories only" : ""}
                <span class="when"> added {dateOf(new Date(g.added_at).toISOString())}{g.added_by ? ` by @${g.added_by}` : ""} · {g.last_fetch_at === null ? "never read" : `last read ${stampOf(g.last_fetch_at)}`}</span>
              </span>
              <button class="btn quiet danger" type="button" data-do="remove-grant" data-account={g.account_id}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form class="form" id="add-grant">
        <label>
          <span>GitHub account id</span>
          <input type="text" name="account_id" required inputmode="numeric" pattern="[1-9][0-9]*" autocomplete="off" spellcheck={false} />
          <span class="hint">The number, not the login. It is the id in <code>https://api.github.com/users/&lt;login&gt;</code>.</span>
        </label>
        <label class="row">
          <input type="checkbox" name="private_repos_only" checked />
          <span>Private repositories only</span>
        </label>
        <div><button class="btn" type="submit">Add account</button></div>
      </form>
    </section>
  );
}

function Reads(props: { view: AccessView }) {
  const served = props.view.fetches.filter((f) => f.outcome === "served");
  const denied = props.view.fetches.filter((f) => f.outcome === "denied");
  return (
    <>
      <section>
        <h2>Reads</h2>
        {served.length === 0 ? <p class="lede">Nothing has read this pack in the last 90 days.</p> : (
          <ul class="list">
            {served.map((f) => (
              <li>
                <span class="grow">{f.kind === "index" ? "Index" : "Download"} · account {f.account_id ?? "unknown"}{f.repository ? ` · ${f.repository}` : ""}</span>
                <span class="when">{stampOf(f.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Denied attempts</h2>
        {denied.length === 0 ? <p class="lede">None in the last 90 days.</p> : (
          <ul class="list">
            {denied.map((f) => (
              <li>
                <span class="grow">{f.kind === "index" ? "Index" : "Download"} · account {f.account_id ?? "unknown"}{f.repository ? ` · ${f.repository}` : ""}</span>
                <span class="when">{stampOf(f.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Changes(props: { view: AccessView }) {
  const { changes } = props.view;
  return (
    <details class="fold section" open>
      <summary>Changes · {plural(changes.length, "entry", "entries")}</summary>
      <div class="body">
        <ul class="list">
          {changes.map((e) => (
            <li>
              <span class="grow">
                {e.action === "visibility.changed" ? `Visibility changed: ${e.change}` : `Account ${e.account_id ?? ""} ${e.change}`}
                <span class="when"> by {e.actor ? `@${e.actor}` : "someone"}</span>
              </span>
              <span class="when">{stampOf(wasAt(e.at))}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

routes.get("/packs/:scope/:name/access", async (c: Context<WebEnv>) => {
  c.header("cache-control", NO_STORE);
  const here = new URL(c.req.url).pathname;
  // A signed-out visitor is sent to sign in whatever the name is, so an allowlisted person has a way in and nobody learns which packs exist.
  const who = await loadWho(c);
  if (!who) return c.redirect(`/signin?next=${encodeURIComponent(here)}`, 303);
  if (who.handle === null) return c.redirect(`/signin?step=handle&next=${encodeURIComponent(here)}`, 303);

  const scope = (c.req.param("scope") ?? "").replace(/^@/, "");
  const { d1 } = c.get("runtime").ports;
  const pack = await findPack(d1, scope, c.req.param("name") ?? "");
  const decision = await authorize(d1, { scope, userId: who.userId, need: "maintainer", resource: "private" });
  if (!pack || decision.kind !== "allow") return notFoundPage(c);

  const view = await loadAccess(d1, pack);
  const nonce = c.get("cspNonce");
  return renderPage(c, {
    title: `Access · @${scope}/${pack.name} · Claudinite Packs`,
    children: (
      <div class="acct">
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS }} />
        <div id="ps" data-csrf={who.csrf} data-user={who.userId} data-pack={`@${scope}/${pack.name}`} />
        <p class="small"><a href={`/packs/@${scope}/${pack.name}`}>@{scope}/{pack.name}</a></p>
        <h1>Access</h1>
        <Visibility view={view} owner={decision.role === "owner"} />
        {pack.visibility === "private" ? <Allowlist view={view} /> : null}
        {pack.visibility === "private" ? <Reads view={view} /> : null}
        <Changes view={view} />
        <p class="status" id="ps-status" role="status" />
        <ActionDialog />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: CLIENT_LIB }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCESS_CLIENT }} />
      </div>
    ),
  });
});
