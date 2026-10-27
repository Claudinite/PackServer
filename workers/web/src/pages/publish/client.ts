/**
 * The browser half of the publish wizard, served inline under the response nonce. One step shows at
 * a time. The archive goes to staging in one presigned PUT from this page, never through a Worker;
 * the check step is a dry-run of those same bytes, and publishing is confirmed with a passkey.
 * Plain ES2017 with no template literals, so it survives being a string.
 */
export const WIZARD_CLIENT = String.raw`
(function () {
  var root = document.getElementById("wiz");
  var PS = window.PS;
  if (!root || !PS) return;
  var boot = JSON.parse(document.getElementById("wiz-state").textContent);
  var form = document.getElementById("source-form");
  var STEPS = ["source", "check", "listing", "visibility", "publish"];
  var POLL_MS = 1500;
  var POLL_LIMIT_MS = 10 * 60 * 1000;

  var s = { pack: "", scope: "", name: "", version: "", bytes: null, sha: "", exists: false, visibility: null, credentialId: "", passed: false, resumed: false };

  function $(id) { return document.getElementById(id); }
  function text(id, value) { $(id).textContent = value; }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function show(step) {
    STEPS.forEach(function (name) {
      var section = root.querySelector('[data-step="' + name + '"]');
      if (section) section.hidden = name !== step;
    });
    Array.prototype.forEach.call(root.querySelectorAll(".steps li"), function (li) {
      if (li.getAttribute("data-for") === step) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }
  function error(id, message) { var el = $(id); el.textContent = message || ""; el.hidden = !message; }
  function mib(bytes) { return (bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1) + " MiB"; }
  function ago(iso) {
    var minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 60) return minutes + " min ago";
    if (minutes < 2880) return Math.round(minutes / 60) + " h ago";
    return Math.round(minutes / 1440) + " days ago";
  }

  var storeKey = function () { return "ps.wizard." + s.pack; };
  function remember() {
    try { localStorage.setItem(storeKey(), JSON.stringify({ version: s.version, sha: s.sha, credentialId: s.credentialId, passed: s.passed })); } catch (e) { /* the draft itself lives on the server */ }
  }
  function recall(pack) {
    try { return JSON.parse(localStorage.getItem("ps.wizard." + pack) || "null"); } catch (e) { return null; }
  }
  function forget() { try { localStorage.removeItem(storeKey()); } catch (e) { /* nothing to clear */ } }

  function refusal(res, data) {
    var e = new Error((data && data.message) || "That did not work. Try again.");
    e.reason = data && data.reason;
    e.status = res.status;
    return e;
  }
  function readJson(res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) throw refusal(res, data);
      return data;
    });
  }
  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  /** One single PUT of the archive to a presigned URL, then the report that it finished. */
  async function stage(grant, bytes) {
    var auth = { authorization: "Bearer " + grant.credential, "content-type": "application/json" };
    var presigned = await readJson(await fetch(grant.presign_path, { method: "POST", headers: auth, body: JSON.stringify({ content_length: bytes.byteLength }) }));
    var headers = {};
    Object.keys(presigned.headers || {}).forEach(function (name) {
      var lower = name.toLowerCase();
      if (lower !== "content-length" && lower !== "host") headers[name] = presigned.headers[name];
    });
    var put;
    try {
      put = await fetch(presigned.url, { method: "PUT", headers: headers, body: bytes });
    } catch (e) {
      throw new Error("The upload stopped before it finished. Nothing was kept; start it again.");
    }
    if (!put.ok) throw new Error("The upload was refused (" + put.status + "). Nothing was kept; start it again.");
    await readJson(await fetch(grant.presign_path.replace(/upload-url$/, "uploaded"), { method: "POST", headers: auth, body: "{}" }));
    return presigned.credential_id;
  }

  function logLines(id, milestones) {
    var list = $(id);
    list.textContent = "";
    milestones.forEach(function (m) {
      var li = document.createElement("li");
      li.textContent = m.step + " · " + m.outcome;
      list.appendChild(li);
    });
  }

  /** Polls a run until it finishes, showing its steps as they arrive. */
  async function follow(id, logId, onTick) {
    var started = Date.now();
    for (;;) {
      var run = await readJson(await fetch("/publish/wizard/runs/" + encodeURIComponent(id), { credentials: "same-origin", headers: { accept: "application/json" } }));
      logLines(logId, run.milestones);
      if (onTick) onTick(run);
      if (run.status === "finished") return run;
      if (Date.now() - started > POLL_LIMIT_MS) throw new Error("This is taking longer than usual. The run keeps going; open its report to follow it.");
      await sleep(POLL_MS);
    }
  }

  function findings(run) {
    var list = $("check-findings");
    list.textContent = "";
    run.findings.forEach(function (f) {
      var li = document.createElement("li");
      li.className = "finding";
      var head = document.createElement("strong");
      head.textContent = f.class === "fail" ? "Fails " : f.class === "hold" ? "Held " : "Warns ";
      var rule = document.createElement("code");
      rule.textContent = f.rule;
      var where = document.createElement("span");
      where.className = "when";
      where.textContent = f.file ? " " + f.file + (f.line === null ? "" : ":" + f.line) : "";
      var hint = document.createElement("div");
      hint.textContent = f.hint;
      li.appendChild(head); li.appendChild(rule); li.appendChild(where); li.appendChild(hint);
      list.appendChild(li);
    });
    var box = $("check-report");
    box.hidden = run.findings.length === 0;
    box.open = run.verdict === "fail";
    text("check-report-summary", "Report · " + run.findings.length);
  }

  function lookup() {
    var name = s.pack;
    return fetch("/publish/wizard/pack?name=" + encodeURIComponent(name), { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (name !== s.pack) return;
        s.exists = !!(data && data.exists);
        s.visibility = data ? data.visibility : null;
        $("price").hidden = !data || data.exists;
      })
      .catch(function () { $("price").hidden = true; });
  }

  function readForm() {
    var scope = form.elements.scope ? form.elements.scope.value : boot.scopes[0];
    s.scope = scope;
    s.name = form.elements.name.value.trim();
    s.pack = "@" + scope + "/" + s.name;
    s.version = form.elements.version.value.trim();
  }

  // ---- source -------------------------------------------------------------------------------
  if (form) {
    var upload = root.querySelector('[data-source="upload"]');
    var repo = root.querySelector('[data-source="repo"]');
    Array.prototype.forEach.call(form.elements.source, function (radio) {
      radio.addEventListener("change", function () {
        var isUpload = form.elements.source.value === "upload";
        upload.hidden = !isUpload;
        repo.hidden = isUpload;
        $("source-next").hidden = !isUpload;
      });
    });
    var onName = function () { readForm(); if (s.name) lookup(); };
    form.elements.name.addEventListener("change", onName);
    if (form.elements.scope) form.elements.scope.addEventListener("change", onName);
    form.elements.archive.addEventListener("change", function () {
      var file = form.elements.archive.files[0];
      text("source-file", file ? file.name + " · " + mib(file.size) : "");
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      error("source-error", "");
      readForm();
      begin().catch(function (err) { error("source-error", err.message); });
    });

    if (boot.pack) {
      s.pack = boot.pack.full;
      s.exists = boot.pack.exists;
      s.visibility = boot.pack.visibility;
      $("price").hidden = boot.pack.exists;
    }
    var note = $("draft-note");
    var draft = boot.draft;
    var last = boot.lastRun;
    if (draft && !draft.expired) {
      form.elements.version.value = draft.version;
      note.hidden = false;
      note.textContent = "A draft of " + draft.version + " is waiting (uploaded " + ago(draft.uploadedAt) + ").";
      var saved = recall(boot.pack.full);
      if (saved && saved.passed && saved.credentialId === draft.credentialId && saved.sha && saved.version === draft.version) {
        s.version = draft.version;
        s.sha = saved.sha;
        s.credentialId = draft.credentialId;
        s.passed = true;
        s.resumed = true;
        note.textContent += " It passed its check; carrying on from the listing.";
      } else {
        note.textContent += " Choose the same archive again to check it and carry on.";
      }
    } else if (draft) {
      form.elements.version.value = draft.version;
      note.hidden = false;
      note.textContent = "The upload of " + draft.version + " expired after 14 days. Upload it again.";
    } else if (last) {
      form.elements.version.value = last.version;
      note.hidden = false;
      note.textContent = "";
      var link = document.createElement("a");
      link.href = "/validation/" + encodeURIComponent(last.id);
      link.textContent = "The last attempt of " + last.version;
      note.appendChild(link);
      note.appendChild(document.createTextNode(last.verdict === "error" ? " stopped on our side. Choose the archive to run it again." : " failed. Fix it and choose the archive again."));
    }
  }

  async function begin() {
    if (!s.name || !s.version) throw new Error("Give the pack a name and a version.");
    var file = form.elements.archive.files[0];
    if (!file) throw new Error("Choose the archive to publish.");
    if (file.size === 0) throw new Error("That file is empty.");
    if (file.size > boot.maxBytes) throw new Error("That archive is " + mib(file.size) + "; the most a web upload takes is " + mib(boot.maxBytes) + ".");
    $("source-next").disabled = true;
    try {
      s.bytes = new Uint8Array(await file.arrayBuffer());
      s.sha = hex(await crypto.subtle.digest("SHA-256", s.bytes));
      s.credentialId = "";
      s.passed = false;
      s.resumed = false;
      await lookup();
    } finally { $("source-next").disabled = false; }
    check();
  }

  // ---- check --------------------------------------------------------------------------------
  function checkFailed(message, retry) {
    error("check-error", message);
    text("check-line", "The check did not finish.");
    $("check-retry").hidden = !retry;
  }

  async function check() {
    show("check");
    error("check-error", "");
    text("check-line", "Uploading the archive.");
    text("check-draft", "");
    $("check-log").textContent = "";
    $("check-report").hidden = true;
    $("check-next").disabled = true;
    $("check-retry").hidden = true;
    var run;
    try {
      var grant = await PS.api("POST", "/publish/wizard/upload", { pack: s.pack, version: s.version, dry_run: true });
      var staged = await stage(grant, s.bytes);
      text("check-line", "Checking. This page updates by itself.");
      var started = await PS.api("POST", "/publish/wizard/check", { pack: s.pack, version: s.version, sha256: s.sha, credential_id: staged });
      run = await follow(started.run_id, "check-log", function (r) { if (r.status !== "finished") text("check-line", r.status === "queued" ? "Waiting to start." : "Checking. This page updates by itself."); });
    } catch (err) {
      checkFailed(err.message, true);
      return;
    }
    text("check-line", run.sentence);
    findings(run);
    if (run.verdict === "fail" || run.verdict === "error") {
      $("check-retry").hidden = run.verdict !== "error";
      return;
    }
    s.passed = true;
    await saveDraft();
  }

  async function saveDraft() {
    if (s.credentialId) { $("check-next").disabled = false; return; }
    text("check-draft", "Saving a draft so you can leave and come back.");
    error("check-error", "");
    $("check-retry").hidden = true;
    try {
      var grant = await PS.api("POST", "/publish/wizard/upload", { pack: s.pack, version: s.version });
      s.credentialId = await stage(grant, s.bytes);
    } catch (err) {
      text("check-draft", "");
      error("check-error", err.message);
      $("check-retry").hidden = false;
      return;
    }
    remember();
    text("check-draft", "Draft saved. It stays for 14 days.");
    $("check-next").disabled = false;
  }

  $("check-retry").addEventListener("click", function () {
    if (s.passed) saveDraft(); else check();
  });
  $("check-next").addEventListener("click", listing);

  // ---- listing ------------------------------------------------------------------------------
  function listing() {
    show("listing");
    text("listing-pack", s.pack);
    text("listing-version", s.version);
    $("no-repo").checked = false;
    $("listing-next").disabled = true;
  }
  $("no-repo").addEventListener("change", function () { $("listing-next").disabled = !$("no-repo").checked; });
  $("listing-next").addEventListener("click", function () {
    show("visibility");
    var radios = root.querySelectorAll('input[name="visibility"]');
    var current = s.exists ? s.visibility : "public";
    Array.prototype.forEach.call(radios, function (radio) {
      radio.checked = radio.value === current;
      radio.disabled = radio.value !== current;
    });
    var noteEl = $("visibility-note");
    noteEl.textContent = "";
    if (s.exists) {
      noteEl.appendChild(document.createTextNode("This pack is " + current + ". "));
      var link = document.createElement("a");
      link.href = "/packs/" + s.pack + "/access";
      link.textContent = "Access settings";
      noteEl.appendChild(link);
      noteEl.appendChild(document.createTextNode(" show who can read it."));
    } else {
      noteEl.textContent = "A new pack is published public. Private packs cannot be started from here yet.";
    }
  });
  $("visibility-next").addEventListener("click", function () {
    show("publish");
    var how = s.exists ? s.visibility : "public";
    text("publish-line", "Publish " + s.pack + " " + s.version + " as " + how + ".");
    text("publish-detail", "It is validated in full before anyone can fetch it. You confirm with your passkey.");
  });

  Array.prototype.forEach.call(root.querySelectorAll("[data-back]"), function (button) {
    button.addEventListener("click", function () { show(button.getAttribute("data-back")); });
  });

  // ---- publish ------------------------------------------------------------------------------
  $("publish-go").addEventListener("click", function () {
    error("publish-error", "");
    PS.sensitive({
      title: "Publish " + s.pack + " " + s.version,
      detail: "The version is validated in full and then promoted, or held for an owner's approval.",
      action: "publish.start",
      target: s.pack + "@" + s.version,
      run: function (assertion) {
        return PS.api("POST", "/publish/wizard/start", { pack: s.pack, version: s.version, sha256: s.sha, credential_id: s.credentialId }, assertion ? { "x-assertion": assertion } : {});
      }
    }).then(function (done) {
      if (done) afterStart(done.result.run_id);
    }).catch(function (err) {
      if (!PS.declined(err)) error("publish-error", err.message);
    });
  });

  async function afterStart(runId) {
    forget();
    $("publish-actions").hidden = true;
    $("publish-detail").textContent = "";
    $("publish-log").hidden = false;
    text("publish-line", "Validating. This page updates by itself.");
    var after = $("publish-after");
    var report = document.createElement("a");
    report.href = "/validation/" + encodeURIComponent(runId);
    report.textContent = "Open the full report";
    after.textContent = "";
    after.appendChild(report);
    after.appendChild(document.createTextNode(" · "));
    var dash = document.createElement("a");
    dash.href = "/dashboard";
    dash.textContent = "Dashboard";
    after.appendChild(dash);
    after.hidden = false;
    try {
      var run = await follow(runId, "publish-log", function (r) { if (r.status !== "finished") text("publish-line", r.status === "queued" ? "Waiting to start." : "Validating. This page updates by itself."); });
      text("publish-line", run.sentence);
      if (run.verdict === "fail" || run.verdict === "error") {
        var again = document.createElement("a");
        again.href = "/publish?pack=" + encodeURIComponent(s.pack);
        again.textContent = run.verdict === "error" ? "Run it again" : "Resubmit";
        after.appendChild(document.createTextNode(" · "));
        after.appendChild(again);
      }
    } catch (err) {
      error("publish-error", err.message);
    }
  }

  show("source");
  if (s.resumed) listing();
})();
`;
