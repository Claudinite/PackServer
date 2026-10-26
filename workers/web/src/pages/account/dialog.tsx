/**
 * The per-action confirmation every sensitive button on the site goes through (REQ-ACC-010). A
 * page renders `ActionDialog` once and calls `PS.sensitive({ title, detail, action, target, run })`
 * from the script in `client.ts`; the dialog gets the assertion made for exactly that action and
 * target, then hands it to `run`.
 */
export function ActionDialog() {
  return (
    <>
      <dialog id="ps-dialog" class="dlg" aria-labelledby="ps-dialog-title">
        <h2 id="ps-dialog-title" data-ps="title"></h2>
        <p class="lede" data-ps="detail"></p>
        <p class="err" role="alert" data-ps="error" hidden></p>
        <p class="lede" data-ps="nopasskey" hidden>This browser cannot use a passkey. Use one of your recovery codes.</p>
        <div class="row mt2">
          <button class="btn primary" type="button" data-ps="passkey">Confirm with your passkey</button>
          <button class="btn" type="button" data-ps="cancel">Cancel</button>
        </div>
        <details class="more mt2" data-ps="recovery">
          <summary>Use a recovery code instead</summary>
          <div class="row mt2">
            <input type="text" data-ps="code" autocomplete="off" spellcheck={false} aria-label="Recovery code" />
            <button class="btn" type="button" data-ps="use">Use code</button>
          </div>
        </details>
      </dialog>
      <dialog id="ps-secrets" class="dlg" aria-labelledby="ps-secrets-title">
        <h2 id="ps-secrets-title" data-ps="title"></h2>
        <p class="lede" data-ps="note"></p>
        <pre class="snippet mt2" data-ps="values"></pre>
        <div class="row mt2">
          <button class="btn" type="button" data-ps="copy">Copy</button>
          <button class="btn primary" type="button" data-ps="done">Done</button>
        </div>
      </dialog>
    </>
  );
}
