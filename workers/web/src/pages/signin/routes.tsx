import { safeReturnTarget } from "@packserver/core/identity";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { CLIENT_LIB } from "../account/client";
import { loadWho } from "../account/data";
import { ActionDialog } from "../account/dialog";
import { ACCOUNT_CSS } from "../account/styles";
import { TURNSTILE_ORIGIN } from "@packserver/ui";
import { SIGNIN_CLIENT } from "./client";

export const routes = new Hono<WebEnv>();

const NO_STORE = "private, no-store";

routes.get("/signin", async (c) => {
  c.header("cache-control", NO_STORE);
  const next = safeReturnTarget(c.req.query("next"));
  const who = await loadWho(c);
  const choosing = c.req.query("step") === "handle";
  if (who && who.handle !== null) return c.redirect(next, 303);
  if (choosing && !who) return c.redirect(`/signin?next=${encodeURIComponent(next)}`, 303);
  const nonce = c.get("cspNonce");
  const handleStep = who !== undefined;
  // Only the page that renders the human check may name Cloudflare's challenge host in its policy.
  if (!handleStep) c.set("turnstilePage", true);

  return renderPage(c, {
    title: "Sign in · Claudinite Packs",
    children: (
      <div class="signin acct">
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS }} />
        <div id="ps" data-csrf={who?.csrf ?? ""} data-next={next} />
        {handleStep ? (
          <>
            <h1>Choose a handle</h1>
            <p class="lede">It names you on every pack you publish. You pick it once.</p>
            <form class="form" id="handle-form">
              <label>
                <span>Handle</span>
                <input type="text" name="handle" required minlength={2} maxlength={39} autocomplete="off" autocapitalize="none" spellcheck={false} />
                <span class="hint">Lowercase letters, digits and single hyphens.</span>
              </label>
              <div><button class="btn primary" type="submit">Continue</button></div>
            </form>
          </>
        ) : (
          <>
            <h1>Sign in</h1>
            <p class="lede">Browsing and searching need no account.</p>
            <div class="stack mt3">
              <div class="stack" id="passkeys" hidden>
                <button class="btn primary" type="button" id="passkey-signin">Sign in with a passkey</button>
                <button class="btn quiet" type="button" id="passkey-signup">Create an account with a passkey</button>
              </div>
              <p class="lede" id="no-webauthn" hidden>This browser cannot use passkeys. Continue with GitHub.</p>
              <button class="btn" type="button" id="github-signin">Continue with GitHub</button>
              <noscript><p class="lede">Signing in needs JavaScript.</p></noscript>
              <div id="human-check" data-sitekey={c.get("runtime").config.turnstileSiteKey ?? ""} />
            </div>
            <details class="more mt3">
              <summary>Lost access?</summary>
              <p class="lede mt2">Sign in with GitHub if it is linked to your account. Otherwise enter a verified email address and we will start a recovery; it takes 72 hours and every address on the account is told.</p>
              <form class="form" id="recover-form">
                <label><span>Email address</span><input type="email" name="email" required autocomplete="email" /></label>
                <div><button class="btn" type="submit">Start recovery</button></div>
              </form>
              <p class="lede" id="recover-done" hidden>If that address belongs to an account, we have emailed it.</p>
            </details>
          </>
        )}
        <p class="status err" id="ps-status" role="alert" />
        <ActionDialog />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: CLIENT_LIB }} />
        {handleStep ? null : <script nonce={nonce} id="turnstile-api" src={`${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit&onload=psTurnstile`} async defer />}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: SIGNIN_CLIENT }} />
      </div>
    ),
  });
});
