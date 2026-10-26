/** The Sign in page's script: passkey ceremonies, the handle step, and the recovery request. Needs `PS` from the account client. */
export const SIGNIN_CLIENT = String.raw`
(function () {
  var PS = window.PS;
  var root = document.getElementById("ps");
  var next = root.getAttribute("data-next") || "/";
  var status = document.getElementById("ps-status");
  function say(message) { status.textContent = message; }

  /**
   * The human check. A token goes with the request when the widget produced one; the unavailable
   * flag goes only when Cloudflare's script failed to load or the widget reported an error.
   */
  var check = { token: null, failed: false, id: null };
  var box = document.getElementById("human-check");
  window.psTurnstile = function () {
    if (!box || check.id !== null || !window.turnstile) return;
    check.id = window.turnstile.render(box, {
      sitekey: box.getAttribute("data-sitekey"),
      callback: function (token) { check.token = token; },
      "expired-callback": function () { check.token = null; },
      "error-callback": function () { check.failed = true; }
    });
  };
  var loader = document.getElementById("turnstile-api");
  if (loader) loader.addEventListener("error", function () { check.failed = true; });
  if (window.turnstile) window.psTurnstile();
  function human() {
    return new Promise(function (resolve) {
      var started = Date.now();
      (function wait() {
        if (check.token) {
          var token = check.token;
          check.token = null;
          if (check.id !== null) window.turnstile.reset(check.id);
          return resolve({ "cf-turnstile-response": token });
        }
        var missing = !window.turnstile && Date.now() - started > 10000;
        if (check.failed || !box || missing) return resolve({ "x-turnstile-unavailable": "1" });
        setTimeout(wait, 100);
      })();
    });
  }
  function anonymous() { return human(); }

  var passkeys = document.getElementById("passkeys");
  if (passkeys) {
    if (!PS.canPasskey) {
      passkeys.hidden = true;
      document.getElementById("no-webauthn").hidden = false;
    } else {
      passkeys.hidden = false;
    }
  }

  function signIn() {
    return anonymous().then(function (h) { return PS.api("POST", "/api/auth/passkey/signin/options", {}, h); }).then(function (data) {
      return PS.getPasskey(data.options);
    }).then(function (response) {
      return PS.api("POST", "/api/auth/passkey/signin/verify", { response: response, next: next });
    }).then(function (done) { location.assign(done.landed_on); });
  }

  function signUp() {
    return anonymous().then(function (h) { return PS.api("POST", "/api/auth/passkey/signup/options", {}, h); }).then(function (data) {
      return PS.createPasskey(data.options);
    }).then(function (response) {
      return PS.api("POST", "/api/auth/passkey/signup/verify", { response: response, next: next });
    }).then(function (done) {
      return PS.refreshCsrf().then(function () {
        return PS.showOnce({
          title: "Your recovery codes",
          note: "Each one works once. Keep them somewhere safe: they are not shown again.",
          values: done.recovery_codes,
          done: "I have saved them"
        });
      }).then(PS.saved).then(function () { location.assign(done.landed_on); });
    });
  }

  function guarded(run) {
    return function (e) {
      e.preventDefault();
      say("");
      run().catch(function (err) {
        say(PS.declined(err) ? "No passkey was chosen." : err.message);
      });
    };
  }
  function github() {
    return anonymous().then(function (h) { return PS.api("POST", "/api/auth/github", { next: next }, h); }).then(function (data) { location.assign(data.redirect); });
  }
  var ghButton = document.getElementById("github-signin");
  if (ghButton) ghButton.addEventListener("click", guarded(github));
  var inButton = document.getElementById("passkey-signin");
  var upButton = document.getElementById("passkey-signup");
  if (inButton) inButton.addEventListener("click", guarded(signIn));
  if (upButton) upButton.addEventListener("click", guarded(signUp));

  var handle = document.getElementById("handle-form");
  if (handle) handle.addEventListener("submit", function (e) {
    e.preventDefault();
    say("");
    PS.api("POST", "/api/auth/handle", { handle: handle.elements.handle.value }).then(function () {
      location.assign(next);
    }, function (err) { say(err.message.replace(/^[a-z]+: /, "")); });
  });

  var recover = document.getElementById("recover-form");
  if (recover) recover.addEventListener("submit", function (e) {
    e.preventDefault();
    anonymous().then(function (h) { return PS.api("POST", "/api/auth/recovery/request", { email: recover.elements.email.value }, h); }).then(function () {
      document.getElementById("recover-done").hidden = false;
    }, function (err) { say(err.message); });
  });
})();
`;
