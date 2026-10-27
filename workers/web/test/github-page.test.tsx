import { createOrg, type ScopeRow } from "@packserver/core/scopes";
import { registerPublisher, setTrustedOnly } from "@packserver/core/publishing";
import { describe, expect, it } from "vitest";
import { PINS, setup, signUp, wordsOf, type Harness } from "./people";

const REPO = { repository: "acme/packs", repository_id: "5150", repository_owner_id: "1001", workflow: ".github/workflows/publish.yml", path: "packs/gcp" };

async function seed(h: Harness) {
  const owner = await signUp(h, "ann");
  const made = await createOrg(h.ports, owner.userId, "acme");
  if (!made.ok) throw new Error(made.message);
  const scope: ScopeRow = made.scope;
  await h.d1.query("insert into packs (id, scope_id, name, visibility, created_at) values ('p1', ?, 'gcp', 'public', '2026-10-01T00:00:00.000Z')", [scope.id]);
  const registered = await registerPublisher(h.ports, { scope, packName: "gcp", userId: owner.userId, input: { ...REPO, environment: "release" } });
  if (!registered.ok) throw new Error(registered.message);
  return { owner, scope, registration: registered.publisher };
}

async function run(h: Harness, scopeId: string, over: Record<string, unknown> = {}) {
  const row = { id: "r1", kind: "publish", status: "finished", verdict: "pass", version: "1.0.0", created_at: "2026-10-20T10:00:00.000Z", pack: "gcp", source: "oidc", synthetic: 0, ...over };
  await h.d1.query(
    `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, synthetic, status, verdict, start_after, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'scope:x', ?, 'k', 'sha', 1, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.kind, row.source, scopeId, row.pack, row.version, `cred-${row.id}`, row.synthetic, row.status, row.verdict, row.created_at, row.created_at, row.created_at],
  );
}

describe("GitHub page (REQ-PUB-001)", () => {
  it("sends a signed-out visitor to sign in and back", async () => {
    const res = await setup().request("/dashboard/github");
    expect([res.status, res.headers.get("location")]).toEqual([303, `/signin?next=${encodeURIComponent("/dashboard/github")}`]);
  });

  it("lists each pack's trusted publisher with repository, path, workflow, ref pattern, events and environment", async () => {
    const h = setup({ workflowPins: PINS });
    const { owner } = await seed(h);
    const res = await owner.get("/dashboard/github");
    const words = wordsOf(await res.text());
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(words).toContain("@acme @acme/gcp");
    expect(words).toContain("acme/packs path packs/gcp");
    expect(words).toContain("Workflow .github/workflows/publish.yml");
    expect(words).toContain("Ref pattern refs/tags/gcp/* refs/heads/main");
    expect(words).toContain("Events push, release, workflow_dispatch");
    expect(words).toContain("Environment release");
  });

  it("reads the registration back into its edit form and offers add, edit and the trusted-only switch to an owner", async () => {
    const h = setup({ workflowPins: PINS });
    const { owner } = await seed(h);
    const html = await (await owner.get("/dashboard/github")).text();
    expect(html).toMatch(/<form class="form reg" data-scope="acme" data-pack="gcp" data-id="[^"]+">/);
    expect(html).toContain('<form class="form reg" data-scope="acme" data-pack="gcp">');
    expect(html).toContain('value="5150"');
    expect(html).toContain('value="packs/gcp"');
    expect(html).toContain('data-do="trusted-only-on"');
    expect(html).toContain("Reserve a name for a pack you have not published");
    for (const e of ["push", "release", "workflow_dispatch"]) expect(html).toMatch(new RegExp(`name="events" value="${e}" checked`));
    expect(html).not.toMatch(/value="(pull_request|pull_request_target|workflow_run)"/);
  });

  it("shows the copyable workflow with the Action pinned by commit SHA and cn by version and hash", async () => {
    const h = setup({ workflowPins: PINS });
    const { owner } = await seed(h);
    const html = await (await owner.get("/dashboard/github")).text();
    const yaml = (/<pre class="snippet" id="yaml-[^"]+">([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    expect(yaml).toContain(`claudinite/publish-pack@${PINS.actionSha}`);
    expect(yaml).toContain(`cn-version: "${PINS.cnVersion}"`);
    expect(yaml).toContain(`cn-sha256: "${PINS.cnSha256}"`);
    expect(yaml).toContain('pack: "@acme/gcp"');
    expect(yaml).toContain('path: "packs/gcp"');
    expect(yaml).toContain('environment: "release"');
    expect(yaml).not.toMatch(/uses: [^\n@]+@v?\d+(\.\d+)*\s*$/m);
    expect(html).toContain('data-do="copy"');
  });

  it("offers no workflow where the environment names no pins, and says so", async () => {
    const h = setup();
    const { owner } = await seed(h);
    const html = await (await owner.get("/dashboard/github")).text();
    expect(html).not.toContain("publish-pack@");
    expect(wordsOf(html)).toContain("This environment has no published Action release to pin yet.");
  });

  it("shows recent trusted-publishing runs with their status in the site's words, newest first, and leaves out upload runs", async () => {
    const h = setup({ workflowPins: PINS });
    const { owner, scope } = await seed(h);
    await run(h, scope.id, { id: "r1", version: "1.0.0", verdict: "pass", created_at: "2026-10-20T10:00:00.000Z" });
    await run(h, scope.id, { id: "r2", version: "1.0.1", verdict: "hold", created_at: "2026-10-21T10:00:00.000Z" });
    await run(h, scope.id, { id: "r3", version: "1.0.2", status: "running", verdict: null, created_at: "2026-10-22T10:00:00.000Z" });
    await run(h, scope.id, { id: "r4", version: "9.9.9", source: "upload", created_at: "2026-10-23T10:00:00.000Z" });
    await run(h, scope.id, { id: "r5", version: "8.8.8", synthetic: 1, created_at: "2026-10-24T10:00:00.000Z" });
    const html = await (await owner.get("/dashboard/github")).text();
    const words = wordsOf(html);
    expect(words).toContain("Recent runs · 3");
    expect(words.indexOf("1.0.2")).toBeLessThan(words.indexOf("1.0.1"));
    expect(words.indexOf("1.0.1")).toBeLessThan(words.indexOf("1.0.0"));
    expect(words).toMatch(/1\.0\.2 2026-10-22 10:00 UTC Validating/);
    expect(words).toMatch(/1\.0\.1 2026-10-21 10:00 UTC Held for review/);
    expect(words).toMatch(/1\.0\.0 2026-10-20 10:00 UTC Passed/);
    expect(words).not.toContain("9.9.9");
    expect(words).not.toContain("8.8.8");
    expect(html).toContain('href="/validation/r2"');
  });

  it("shows a name reserved for a pack that is not published yet, with the day the reservation ends", async () => {
    const h = setup({ workflowPins: PINS });
    const { owner, scope } = await seed(h);
    const pending = await registerPublisher(h.ports, { scope, packName: "next", userId: owner.userId, input: { ...REPO, path: "packs/next" } });
    if (!pending.ok) throw new Error(pending.message);
    const words = wordsOf(await (await owner.get("/dashboard/github")).text());
    expect(words).toContain("@acme/next · name reserved, not published yet");
    expect(words).toMatch(/Reserves the name until \d{4}-\d{2}-\d{2}\./);
  });

  it("says when web uploads are off and offers to turn them on again", async () => {
    const h = setup({ workflowPins: PINS });
    const { owner, scope } = await seed(h);
    await setTrustedOnly(h.ports, scope.id, "gcp", true);
    const html = await (await owner.get("/dashboard/github")).text();
    expect(wordsOf(html)).toContain("Web uploads are off: only trusted publishers can publish this pack.");
    expect(html).toContain('data-do="trusted-only-off"');
    expect(html).not.toContain('data-do="trusted-only-on"');
  });

  it("shows a maintainer the registrations and runs without a way to change them", async () => {
    const h = setup({ workflowPins: PINS });
    const { scope } = await seed(h);
    const max = await signUp(h, "max");
    await h.d1.query("insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, 'maintainer', '2026-10-01T00:00:00.000Z')", [scope.id, max.userId]);
    const page = await (await max.get("/dashboard/github")).text();
    const html = page.slice(page.indexOf('data-scope="acme"'), page.indexOf('data-scope="max"') > page.indexOf('data-scope="acme"') ? page.indexOf('data-scope="max"') : undefined);
    expect(wordsOf(html)).toContain("acme/packs");
    expect(html).not.toMatch(/<form/);
    expect(html).not.toMatch(/data-do="trusted-only/);
  });

  it("neither shows nor reaches for another organisation's packs", async () => {
    const h = setup({ workflowPins: PINS });
    await seed(h);
    const zed = await signUp(h, "zed");
    const words = wordsOf(await (await zed.get("/dashboard/github")).text());
    expect(words).not.toContain("acme");
    expect(words).toContain("@zed");
  });

  it("writes nothing to GitHub: the page's scripts only call this site", async () => {
    const h = setup({ workflowPins: PINS });
    const { owner } = await seed(h);
    const html = await (await owner.get("/dashboard/github")).text();
    const scripts = (html.match(/<script[^>]*>[\s\S]*?<\/script>/g) ?? []).join("\n");
    expect(scripts).not.toMatch(/github\.com/);
    expect(scripts).not.toMatch(/fetch\(\s*["']https?:/);
    for (const tag of html.match(/<script[^>]*>/g) ?? []) expect(tag).toMatch(/^<script nonce="[0-9a-f]+">$/);
  });
});
