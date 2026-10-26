import { Hono, type Context } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { CLIENT_LIB } from "./client";
import { loadSecurity, loadWho, type SecurityData, type Who } from "./data";
import { ActionDialog } from "./dialog";
import { dateOf, eventText, plural, stampOf } from "./format";
import { SECURITY_CLIENT } from "./security-client";
import { ACCOUNT_CSS } from "./styles";

export const routes = new Hono<WebEnv>();

const NO_STORE = "private, no-store";

/** The signed-in person, or the redirect to sign in that brings them back here. */
async function signedIn(c: Context<WebEnv>): Promise<Who | Response> {
  const who = await loadWho(c);
  if (!who) {
    const here = new URL(c.req.url);
    c.header("cache-control", NO_STORE);
    return c.redirect(`/signin?next=${encodeURIComponent(here.pathname + here.search)}`, 303);
  }
  if (who.handle === null) {
    c.header("cache-control", NO_STORE);
    return c.redirect(`/signin?step=handle&next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 303);
  }
  return who;
}

function Scripts(props: { nonce: string; page?: string }) {
  return (
    <>
      <script nonce={props.nonce} dangerouslySetInnerHTML={{ __html: CLIENT_LIB }} />
      {props.page ? <script nonce={props.nonce} dangerouslySetInnerHTML={{ __html: props.page }} /> : null}
    </>
  );
}

routes.get("/account", async (c) => {
  const who = await signedIn(c);
  if (who instanceof Response) return who;
  c.header("cache-control", NO_STORE);
  const nonce = c.get("cspNonce");
  return renderPage(c, {
    title: "Account · Claudinite Packs",
    children: (
      <div class="acct">
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS }} />
        <div id="ps" data-csrf={who.csrf} data-user={who.userId} />
        <h1>Account</h1>
        <p class="lede"><a href={`/@${who.handle}`}>@{who.handle}</a></p>
        <section>
          <p><a href="/account/security">Security</a></p>
          <p class="muted small">Passkeys, recovery codes, sessions, read tokens and your history.</p>
        </section>
        <section>
          <button class="btn" type="button" data-do="sign-out">Sign out</button>
          <p class="status" id="ps-status" role="status"></p>
        </section>
        <ActionDialog />
        <Scripts nonce={nonce} page={SECURITY_CLIENT} />
      </div>
    ),
  });
});

function Alert(props: { data: SecurityData; enrolling: boolean }) {
  const { data } = props;
  if (props.enrolling && data.passkeys.length === 0) {
    return (
      <p class="alert" role="status">
        <span class="dot" /> <span>Add a passkey. Publishing and managing packs need one.</span>
        <button class="btn" type="button" data-do="enrol" data-first="1">Add a passkey</button>
      </p>
    );
  }
  if (data.recovery.has_codes && !data.recovery.saved) {
    return (
      <p class="alert" role="status">
        <span class="dot" /> <span>Your recovery codes are not confirmed as saved.</span>
        <button class="btn" type="button" data-do="regenerate">Make new codes</button>
        <button class="btn quiet" type="button" data-do="saved">I saved them</button>
      </p>
    );
  }
  return null;
}

function Passkeys(props: { data: SecurityData }) {
  const { data } = props;
  const first = data.passkeys.length === 0;
  return (
    <section>
      <h2>Passkeys</h2>
      {first ? <p class="lede">No passkey yet. Publishing and managing packs need one.</p> : null}
      <ul class="list">
        {data.passkeys.map((k) => (
          <li>
            <span class="grow">{k.label ?? "Passkey"} <span class="when">added {dateOf(k.created_at)} · last used {dateOf(k.last_used_at)}</span>
              {k.hold_until !== null && Date.parse(k.hold_until) > data.now ? <span class="when"> · cannot authorise publishing until {dateOf(k.hold_until)}</span> : null}
            </span>
            <button class="btn quiet danger" type="button" data-do="remove-passkey" data-id={k.id} data-label={k.label ?? "Passkey added " + dateOf(k.created_at)}>Remove</button>
          </li>
        ))}
      </ul>
      <p class="mt2"><button class="btn" type="button" data-do="enrol" data-first={first ? "1" : "0"}>Add a passkey</button></p>
    </section>
  );
}

function Recovery(props: { data: SecurityData }) {
  const { recovery } = props.data;
  if (!recovery.has_codes) return null;
  return (
    <section>
      <h2>Recovery codes</h2>
      <p class="lede">{plural(recovery.remaining, "code")} left. A code confirms an action when you cannot use a passkey.</p>
      <p class="mt2"><button class="btn" type="button" data-do="regenerate">Make new codes</button></p>
    </section>
  );
}

function Methods(props: { data: SecurityData }) {
  const github = props.data.identities.find((i) => i.provider === "github");
  return (
    <section>
      <h2>Sign-in methods</h2>
      <ul class="list">
        <li><span class="grow">{props.data.passkeys.length > 0 ? plural(props.data.passkeys.length, "passkey") : "No passkey"}</span></li>
        <li>
          <span class="grow">{github ? <>GitHub <span class="when">{github.login}</span></> : "GitHub is not linked"}</span>
          {github ? null : <button class="btn quiet" type="button" data-do="link-github">Link GitHub</button>}
        </li>
      </ul>
    </section>
  );
}

function Sessions(props: { data: SecurityData }) {
  const { sessions } = props.data;
  return (
    <details class="fold section">
      <summary>Sessions · {sessions.length}</summary>
      <div class="body">
        <ul class="list">
          {sessions.map((s) => (
            <li>
              <span class="grow">{s.device.label}{s.current ? " · this device" : ""} <span class="when">last seen {stampOf(s.last_seen)}</span></span>
              <button class="btn quiet" type="button" data-do="revoke-session" data-id={s.id} data-current={s.current ? "1" : "0"}>{s.current ? "Sign out" : "Revoke"}</button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function Tokens(props: { data: SecurityData }) {
  const { tokens } = props.data;
  const live = tokens.filter((t) => t.status === "active");
  return (
    <details class="fold section" id="tokens">
      <summary>Read tokens · {live.length}</summary>
      <div class="body">
        <p class="lede">A read token lets a machine fetch private packs. It never publishes.</p>
        <ul class="list">
          {tokens.map((t) => (
            <li>
              <span class="grow">
                <code>{t.hint}</code> {t.label ?? ""} <span class="when">{t.pack ?? `@${t.scope}`} · last used {dateOf(t.last_used_at)} · {t.status === "active" ? `expires ${dateOf(t.expires_at)}` : t.status}</span>
              </span>
              {t.status === "active" ? <button class="btn quiet danger" type="button" data-do="revoke-token" data-id={t.id}>Revoke</button> : null}
            </li>
          ))}
        </ul>
        {props.data.passkeys.length > 0 ? (
          <form class="form" id="mint-token">
            <label>
              <span>Pack or scope</span>
              <input type="text" name="restrict" required placeholder="@acme/pack or @acme" autocomplete="off" spellcheck={false} />
            </label>
            <label>
              <span>Lasts for (days)</span>
              <input type="number" name="days" min="1" max="365" value="7" />
            </label>
            <details class="more">
              <summary>More options</summary>
              <div class="stack mt2">
                <label><span>Label</span><input type="text" name="label" maxlength={80} autocomplete="off" /></label>
                <label><span>Only from these addresses</span><input type="text" name="cidr" placeholder="10.0.0.0/8, 192.0.2.1" autocomplete="off" spellcheck={false} /></label>
              </div>
            </details>
            <div><button class="btn" type="submit">Create token</button></div>
          </form>
        ) : (
          <p class="lede mt2">Add a passkey to create read tokens.</p>
        )}
      </div>
    </details>
  );
}

function History(props: { data: SecurityData }) {
  const { history } = props.data;
  return (
    <details class="fold section" id="history">
      <summary>History · {plural(history.length, "event")} in the last 90 days</summary>
      <div class="body">
        {history.length === 0 ? <p class="lede">Nothing yet.</p> : (
          <ul class="list">
            {history.map((e) => <li><span class="grow">{eventText(e.action)}</span><span class="when">{stampOf(Date.parse(e.at))}</span></li>)}
          </ul>
        )}
      </div>
    </details>
  );
}

routes.get("/account/security", async (c) => {
  const who = await signedIn(c);
  if (who instanceof Response) return who;
  c.header("cache-control", NO_STORE);
  const data = await loadSecurity(c, who);
  const nonce = c.get("cspNonce");
  return renderPage(c, {
    title: "Security · Claudinite Packs",
    children: (
      <div class="acct">
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS }} />
        <div id="ps" data-csrf={who.csrf} data-user={who.userId} />
        <p class="small"><a href="/account">Account</a></p>
        <h1>Security</h1>
        <Alert data={data} enrolling={c.req.query("step") === "enrol"} />
        <Passkeys data={data} />
        <Recovery data={data} />
        <Methods data={data} />
        <Sessions data={data} />
        <Tokens data={data} />
        <History data={data} />
        <details class="fold section">
          <summary>Delete account</summary>
          <div class="body">
            <p class="lede">This removes your sign-in methods, sessions and tokens, and retires your handle.</p>
            <p class="mt2"><button class="btn danger" type="button" data-do="delete-account">Delete account</button></p>
          </div>
        </details>
        <p class="status" id="ps-status" role="status" />
        <ActionDialog />
        <Scripts nonce={nonce} page={SECURITY_CLIENT} />
      </div>
    ),
  });
});

