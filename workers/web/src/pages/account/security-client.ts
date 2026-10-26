/** Wires the Security page's buttons to the routes behind them; every sensitive one goes through `PS.sensitive`. */
export const SECURITY_CLIENT = String.raw`
(function () {
  var PS = window.PS;
  var host = document.getElementById("ps");
  var user = host.getAttribute("data-user");
  var status = document.getElementById("ps-status");
  var reload = function () { location.reload(); };
  var withAssertion = function (assertion) { return assertion ? { "x-assertion": assertion } : {}; };

  function say(message) { status.textContent = message; }

  function showCodes(codes) {
    return PS.showOnce({
      title: "Your recovery codes",
      note: "Each one works once. Keep them somewhere safe: they are not shown again.",
      values: codes,
      done: "I have saved them"
    }).then(PS.saved);
  }

  function enrol(assertion) {
    return PS.api("POST", "/api/auth/passkey/enrol/options", {}).then(function (data) {
      return PS.createPasskey(data.options);
    }).then(function (response) {
      return PS.api("POST", "/api/auth/passkey/enrol/verify", { response: response }, withAssertion(assertion));
    });
  }

  var actions = {
    "enrol": function (button) {
      if (!PS.canPasskey) return Promise.reject(new Error("This browser cannot make a passkey. Use another browser or device."));
      var finish = function (data) { return data.recovery_codes ? showCodes(data.recovery_codes) : Promise.resolve(); };
      if (button.getAttribute("data-first") === "1") return enrol().then(finish).then(reload);
      return PS.sensitive({ title: "Add a passkey", detail: "Confirm with a passkey you already have.", action: "factor.add", target: user, run: enrol }).then(function (done) {
        if (done) return finish(done.result).then(reload);
      });
    },
    "remove-passkey": function (button) {
      var id = button.getAttribute("data-id");
      return PS.sensitive({
        title: "Remove this passkey", detail: button.getAttribute("data-label"), action: "factor.remove", target: id,
        run: function (assertion) { return PS.api("POST", "/api/auth/passkeys/" + encodeURIComponent(id) + "/remove", {}, withAssertion(assertion)); }
      }).then(function (done) { if (done) reload(); });
    },
    "regenerate": function () {
      return PS.sensitive({
        title: "Make new recovery codes", detail: "The codes you have now stop working.", action: "recovery.regenerate", target: user,
        run: function (assertion) { return PS.api("POST", "/api/auth/recovery/regenerate", {}, withAssertion(assertion)); }
      }).then(function (done) { if (done) return showCodes(done.result.recovery_codes).then(reload); });
    },
    "saved": function () { return PS.saved().then(reload); },
    "link-github": function () {
      return PS.sensitive({
        title: "Link GitHub", detail: "You will go to GitHub and come back here.", action: "provider.link", target: "github",
        run: function (assertion) { return PS.api("POST", "/api/auth/providers/github/link", { next: "/account/security" }, withAssertion(assertion)); }
      }).then(function (done) { if (done) location.assign(done.result.redirect); });
    },
    "revoke-session": function (button) {
      var current = button.getAttribute("data-current") === "1";
      return PS.api("POST", "/api/auth/sessions/" + encodeURIComponent(button.getAttribute("data-id")) + "/revoke", {}).then(function () {
        if (current) location.assign("/"); else reload();
      });
    },
    "revoke-token": function (button) {
      return PS.api("DELETE", "/api/tokens/" + encodeURIComponent(button.getAttribute("data-id"))).then(reload);
    },
    "delete-account": function () {
      return PS.sensitive({
        title: "Delete this account", detail: "Your sign-in methods, sessions and tokens are removed and the handle is retired.", action: "account.delete", target: user,
        run: function (assertion) { return PS.api("POST", "/api/auth/delete", {}, withAssertion(assertion)); }
      }).then(function (done) { if (done) location.assign("/"); });
    },
    "sign-out": function () {
      return PS.api("POST", "/api/auth/signout", {}).then(function () { location.assign("/"); });
    }
  };

  document.addEventListener("click", function (e) {
    var button = e.target.closest ? e.target.closest("[data-do]") : null;
    if (!button) return;
    var act = actions[button.getAttribute("data-do")];
    if (!act) return;
    e.preventDefault();
    say("");
    act(button).catch(function (err) { if (!PS.declined(err)) say(err.message); });
  });

  var mint = document.getElementById("mint-token");
  if (mint) mint.addEventListener("submit", function (e) {
    e.preventDefault();
    say("");
    var f = mint.elements;
    var restrict = f.restrict.value.trim();
    var body = restrict.indexOf("/") > 0 ? { pack: restrict } : { scope: restrict };
    if (f.days.value) body.lifetime_days = Number(f.days.value);
    if (f.label.value.trim()) body.label = f.label.value.trim();
    var cidr = f.cidr.value.split(/[\s,]+/).filter(Boolean);
    if (cidr.length) body.cidr = cidr;
    PS.sensitive({
      title: "Create a read token", detail: "Read access to " + restrict + ".", action: "token.mint", target: restrict,
      run: function (assertion) { return PS.api("POST", "/api/tokens", body, withAssertion(assertion)); }
    }).then(function (done) {
      if (!done) return;
      return PS.showOnce({ title: "Your read token", note: "Copy it now. It is not shown again.", values: [done.result.token], done: "Done" }).then(reload);
    }).catch(function (err) { if (!PS.declined(err)) say(err.message); });
  });
})();
`;
