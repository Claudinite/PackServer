/** Wires the organisation settings page to the routes behind it; every sensitive control goes through `PS.sensitive`. */
export const ORG_CLIENT = String.raw`
(function () {
  var PS = window.PS;
  var host = document.getElementById("ps");
  var org = host.getAttribute("data-org");
  var status = document.getElementById("ps-status");
  var base = "/api/orgs/" + encodeURIComponent(org);
  var reload = function () { location.reload(); };
  var withAssertion = function (assertion) { return assertion ? { "x-assertion": assertion } : {}; };
  var enc = encodeURIComponent;

  function say(message) { status.textContent = message; }

  function sensitive(title, detail, action, target, run) {
    return PS.sensitive({ title: title, detail: detail, action: action, target: target, run: run });
  }

  var CHECKED = {
    mismatch: "The record is there, but it holds a different token.",
    missing: "The record was not found yet. DNS can take a while to show up.",
    unreachable: "The domain could not be reached."
  };

  var actions = {
    "check-domain": function (button) {
      return PS.api("POST", base + "/verification/domain/" + enc(button.getAttribute("data-id")) + "/check", {}).then(function (data) {
        var r = data.result;
        if (r.status === "verified") return reload();
        say((CHECKED[r.status] || "Not proven yet.") + (r.detail ? " " + r.detail : ""));
      });
    },
    "apply": function () {
      return sensitive("Apply for Verified Publisher", "An admin reviews the application. Nothing is charged.", "org.apply-verified", org, function (assertion) {
        return PS.api("POST", base + "/application", {}, withAssertion(assertion));
      }).then(function (done) { if (done) reload(); });
    },
    "set-role": function (button) {
      var handle = button.getAttribute("data-handle");
      var role = button.getAttribute("data-role");
      return sensitive("Make @" + handle + " " + (role === "owner" ? "an owner" : "a maintainer"), "@" + org, "org.set-role", org + "/" + handle, function (assertion) {
        return PS.api("POST", base + "/people/" + enc(handle) + "/role", { role: role }, withAssertion(assertion));
      }).then(function (done) { if (done) reload(); });
    },
    "remove-person": function (button) {
      var handle = button.getAttribute("data-handle");
      return sensitive("Remove @" + handle, "They can no longer act for @" + org + ".", "org.remove", org + "/" + handle, function (assertion) {
        return PS.api("DELETE", base + "/people/" + enc(handle), undefined, withAssertion(assertion));
      }).then(function (done) { if (done) reload(); });
    },
    "remove-invitation": function (button) {
      var id = button.getAttribute("data-id");
      return sensitive("Withdraw the invitation", "@" + org, "org.remove", org + "/invitations/" + id, function (assertion) {
        return PS.api("DELETE", base + "/invitations/" + enc(id), undefined, withAssertion(assertion));
      }).then(function (done) { if (done) reload(); });
    },
    "delete-org": function () {
      return sensitive("Delete @" + org, "The name is retired for good.", "org.delete", org, function (assertion) {
        return PS.api("DELETE", base, undefined, withAssertion(assertion));
      }).then(function (done) { if (done) location.assign("/account"); });
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

  function onSubmit(id, handler) {
    var form = document.getElementById(id);
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      say("");
      handler(form.elements).catch(function (err) { if (!PS.declined(err)) say(err.message); });
    });
  }

  onSubmit("prove-domain", function (f) {
    var domain = f.domain.value.trim();
    return sensitive("Prove " + domain, "You will get a record to publish; nothing is proven until you check.", "org.prove-domain", org + "/" + domain.toLowerCase(), function (assertion) {
      return PS.api("POST", base + "/verification/domain", { domain: domain }, withAssertion(assertion));
    }).then(function (done) { if (done) reload(); });
  });

  onSubmit("prove-github", function (f) {
    var github = f.org.value.trim();
    var method = f.method.value;
    return sensitive("Prove the GitHub organisation " + github, "@" + org, "org.prove-github", org + "/" + github.toLowerCase(), function (assertion) {
      return PS.api("POST", base + "/verification/github", { org: github, method: method }, withAssertion(assertion));
    }).then(function (done) { if (done) reload(); });
  });

  onSubmit("invite", function (f) {
    var who = f.who.value.trim().replace(/^@/, "");
    var body = who.indexOf("@") > 0 ? { email: who } : { handle: who };
    body.role = f.role.value;
    return sensitive("Invite " + who, "As " + body.role + " of @" + org + ". Nothing is granted until they accept.", "org.invite", org, function (assertion) {
      return PS.api("POST", base + "/people", body, withAssertion(assertion));
    }).then(function (done) { if (done) reload(); });
  });

  onSubmit("mfa-policy", function (f) {
    var policy = f.policy.value;
    return sensitive("Change the sign-in requirement", "For everyone acting for @" + org + ".", "org.mfa-policy", org, function (assertion) {
      return PS.api("POST", base + "/mfa-policy", { policy: policy }, withAssertion(assertion));
    }).then(function (done) { if (done) reload(); });
  });

  onSubmit("transfer", function (f) {
    var pack = f.pack.value;
    var to = f.to.value.trim().replace(/^@/, "");
    var name = pack.slice(pack.indexOf("/") + 1);
    return sensitive("Offer " + pack + " to @" + to, "Nothing moves until an owner of @" + to + " accepts.", "pack.transfer", org + "/" + name, function (assertion) {
      return PS.api("POST", "/api/scopes/" + enc(org) + "/packs/" + enc(name) + "/transfer", { to: to }, withAssertion(assertion));
    }).then(function (done) { if (done) say("Offered to @" + to + "."); });
  });
})();
`;
