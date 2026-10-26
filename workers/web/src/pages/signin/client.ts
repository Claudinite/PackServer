/** The Sign in page's script: passkey ceremonies, the handle step, and the recovery request. Needs `PS` from the account client. */
export const SIGNIN_CLIENT = String.raw`
(function () {
  var PS = window.PS;
  var root = document.getElementById("ps");
  var next = root.getAttribute("data-next") || "/";
  var status = document.getElementById("ps-status");
  var anonymous = { "x-turnstile-unavailable": "1" };
  function say(message) { status.textContent = message; }

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
    return PS.api("POST", "/api/auth/passkey/signin/options", {}, anonymous).then(function (data) {
      return PS.getPasskey(data.options);
    }).then(function (response) {
      return PS.api("POST", "/api/auth/passkey/signin/verify", { response: response, next: next });
    }).then(function (done) { location.assign(done.landed_on); });
  }

  function signUp() {
    return PS.api("POST", "/api/auth/passkey/signup/options", {}, anonymous).then(function (data) {
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
    PS.api("POST", "/api/auth/recovery/request", { email: recover.elements.email.value }, anonymous).then(function () {
      document.getElementById("recover-done").hidden = false;
    }, function (err) { say(err.message); });
  });
})();
`;
