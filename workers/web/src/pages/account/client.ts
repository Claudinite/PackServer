/**
 * The browser half of the sign-in and account pages, served inline under the response nonce.
 * Plain ES2017 with no template literals, so it survives being a string. `PS.api` talks to the
 * JSON routes under /api and keeps the session's CSRF token current; `PS.sensitive` is the one
 * way any page asks for a per-action assertion (REQ-ACC-010) and runs the action it unlocks.
 */
export const CLIENT_LIB = String.raw`
(function () {
  var PS = (window.PS = {});
  var host = document.getElementById("ps");
  PS.csrf = host ? host.getAttribute("data-csrf") || "" : "";
  PS.canPasskey = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

  function bytes(text) {
    var s = text.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out.buffer;
  }
  function text(buffer) {
    var u = new Uint8Array(buffer);
    var s = "";
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function nonce() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }
  function failure(res, data) {
    var e = new Error((data && data.message) || "That did not work. Try again.");
    e.reason = data && data.reason;
    e.status = res.status;
    return e;
  }

  PS.api = function (method, path, body, headers) {
    var h = { "x-csrf-token": PS.csrf, "idempotency-key": nonce(), accept: "application/json" };
    if (body !== undefined) h["content-type"] = "application/json";
    for (var k in headers || {}) h[k] = headers[k];
    return fetch(path, { method: method, headers: h, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (data && typeof data.csrf === "string") PS.csrf = data.csrf;
        if (!res.ok) throw failure(res, data);
        return data;
      });
    });
  };

  PS.refreshCsrf = function () {
    return PS.api("GET", "/api/auth/session").then(function (data) { PS.csrf = data.csrf; });
  };

  function create(options) {
    options.challenge = bytes(options.challenge);
    options.user.id = bytes(options.user.id);
    (options.excludeCredentials || []).forEach(function (c) { c.id = bytes(c.id); });
    return navigator.credentials.create({ publicKey: options });
  }
  function get(options) {
    options.challenge = bytes(options.challenge);
    (options.allowCredentials || []).forEach(function (c) { c.id = bytes(c.id); });
    return navigator.credentials.get({ publicKey: options });
  }
  function json(cred) {
    var r = cred.response;
    var out = { id: cred.id, rawId: text(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), response: { clientDataJSON: text(r.clientDataJSON) } };
    if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
    if (r.attestationObject) {
      out.response.attestationObject = text(r.attestationObject);
      if (r.getTransports) out.response.transports = r.getTransports();
    } else {
      out.response.authenticatorData = text(r.authenticatorData);
      out.response.signature = text(r.signature);
      if (r.userHandle) out.response.userHandle = text(r.userHandle);
    }
    return out;
  }
  PS.createPasskey = function (options) { return create(options).then(json); };
  PS.getPasskey = function (options) { return get(options).then(json); };

  /** A person who closed or refused the browser's prompt has changed their mind, which is not an error. */
  PS.declined = function (e) { return !!e && (e.name === "NotAllowedError" || e.name === "AbortError"); };

  var dialog = document.getElementById("ps-dialog");
  function part(name) { return dialog.querySelector('[data-ps="' + name + '"]'); }

  /**
   * Asks for an assertion made for this action and target, then runs the action with it. The dialog
   * stays open on a failure so the person can try again, and closes when the action has gone through.
   */
  PS.sensitive = function (ask) {
    return new Promise(function (resolve) {
      var busy = false;
      var error = part("error");
      var passkey = part("passkey");
      var codeBox = part("recovery");
      var codeInput = part("code");
      part("title").textContent = ask.title;
      part("detail").textContent = ask.detail || "";
      error.hidden = true;
      codeInput.value = "";
      passkey.hidden = !PS.canPasskey;
      codeBox.open = !PS.canPasskey;
      part("nopasskey").hidden = PS.canPasskey;

      function show(message) { error.textContent = message; error.hidden = false; }
      function finish(value) { cleanup(); dialog.close(); resolve(value); }
      function attempt(proof) {
        if (busy) return;
        busy = true;
        error.hidden = true;
        part("passkey").disabled = part("use").disabled = true;
        proof().then(function (assertion) {
          return ask.run(assertion);
        }).then(function (result) {
          busy = false;
          finish({ result: result });
        }, function (e) {
          busy = false;
          part("passkey").disabled = part("use").disabled = false;
          if (!PS.declined(e)) show(e.message);
        });
      }
      function asserted(extra) {
        var subject = { action: ask.action, target: ask.target || "" };
        var body = Object.assign({}, subject, extra);
        return PS.api("POST", "/api/auth/assert", body).then(function (data) { return data.assertion; });
      }
      function byPasskey() {
        return PS.api("POST", "/api/auth/assert/options", { action: ask.action, target: ask.target || "" }).then(function (data) {
          return PS.getPasskey(data.options);
        }).then(function (response) { return asserted({ response: response }); });
      }
      function byCode() {
        var code = codeInput.value.trim();
        if (!code) return Promise.reject(new Error("Enter one of your recovery codes."));
        return asserted({ recovery_code: code });
      }
      function onPasskey() { attempt(byPasskey); }
      function onCode() { attempt(byCode); }
      function onCancel() { finish(null); }
      function onClose() { if (!busy) { cleanup(); resolve(null); } }
      function cleanup() {
        passkey.removeEventListener("click", onPasskey);
        part("use").removeEventListener("click", onCode);
        part("cancel").removeEventListener("click", onCancel);
        dialog.removeEventListener("close", onClose);
      }
      passkey.addEventListener("click", onPasskey);
      part("use").addEventListener("click", onCode);
      part("cancel").addEventListener("click", onCancel);
      dialog.addEventListener("close", onClose);
      dialog.showModal();
    });
  };

  var secrets = document.getElementById("ps-secrets");
  /** Shows values the server will never show again; resolves when the person closes the panel. */
  PS.showOnce = function (opts) {
    return new Promise(function (resolve) {
      secrets.querySelector('[data-ps="title"]').textContent = opts.title;
      secrets.querySelector('[data-ps="note"]').textContent = opts.note;
      secrets.querySelector('[data-ps="values"]').textContent = opts.values.join("\n");
      var done = secrets.querySelector('[data-ps="done"]');
      var copy = secrets.querySelector('[data-ps="copy"]');
      done.textContent = opts.done;
      function onCopy() { navigator.clipboard && navigator.clipboard.writeText(opts.values.join("\n")).then(function () { copy.textContent = "Copied"; }); }
      function onDone() {
        done.removeEventListener("click", onDone);
        copy.removeEventListener("click", onCopy);
        secrets.close();
        resolve();
      }
      copy.textContent = "Copy";
      copy.addEventListener("click", onCopy);
      done.addEventListener("click", onDone);
      secrets.addEventListener("cancel", function (e) { e.preventDefault(); });
      secrets.showModal();
    });
  };

  PS.saved = function () { return PS.api("POST", "/api/auth/recovery/saved", {}); };
})();
`;
